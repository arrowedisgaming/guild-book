import { expect, test, type Page } from '@playwright/test';
import { signInAs, createTestAdventurer } from './fixtures/auth';

type SavedEntry = { itemId: string | null; location: string; notchesTaken: number };

/** Resolves on the first character PUT whose payload satisfies `check`. */
function savedWhere(page: Page, check: (equipment: SavedEntry[]) => boolean) {
	return page.waitForResponse((response) => {
		const request = response.request();
		if (request.method() !== 'PUT' || !response.url().includes('/api/characters/')) return false;
		const body = JSON.parse(request.postData() ?? '{}') as { character?: { equipment?: SavedEntry[] } };
		return response.ok() && check(body.character?.equipment ?? []);
	});
}

const at = (equipment: SavedEntry[], itemId: string) => equipment.find((e) => e.itemId === itemId);

async function openSheet(page: Page, role: string, name: string) {
	await signInAs(page, role);
	const { id } = await createTestAdventurer(page, name);
	await page.goto(`/sheet/${id}`);
	return page.getByRole('region', { name: 'Gear', exact: true });
}

/** A row's less-used controls sit beneath it; open the row if it is closed. */
async function openRow(page: Page, name: string) {
	const toggle = page
		.getByRole('region', { name: 'Gear', exact: true })
		.getByRole('listitem')
		.filter({ hasText: name })
		.locator('button.iname');
	if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

/** The carry-location select of an item, with its row opened first. */
async function locationOf(page: Page, name: string) {
	await openRow(page, name);
	return page.getByLabel(`Location of ${name}`);
}

async function addItem(page: Page, name: string) {
	const gear = page.getByRole('region', { name: 'Gear', exact: true });
	// Type the name into the filter box; Enter takes the best match.
	const market = gear.getByLabel('Add an item from the market');
	await market.fill(name);
	await expect(gear.getByRole('option').first()).toContainText(name);
	await market.press('Enter');
	await expect(gear.getByRole('listitem').filter({ hasText: name })).toHaveCount(1);
}

const group = (page: Page, prefix: string) =>
	page
		.getByRole('region', { name: 'Gear', exact: true })
		.getByRole('region', { name: new RegExp(`^${prefix}`) });

test('moves gear in place and persists', async ({ page }) => {
	await openSheet(page, 'Gear Mover', 'Hilde Quickhand');
	await addItem(page, 'Dagger');
	const saved = savedWhere(page, (eq) => at(eq, 'weapon-dagger')?.location === 'hand');
	await (await locationOf(page, 'Dagger')).selectOption('hand');
	// Focus follows the row into its new group.
	await expect(await locationOf(page, 'Dagger')).toBeFocused();
	await expect(group(page, 'In hand').getByRole('listitem').filter({ hasText: 'Dagger' })).toBeVisible();
	await expect(group(page, 'In hand')).toHaveAccessibleName(/1 open/);
	await saved;
	await page.reload();
	await expect(group(page, 'In hand').getByRole('listitem').filter({ hasText: 'Dagger' })).toBeVisible();
	await expect(group(page, 'In hand')).toHaveAccessibleName(/1 open/);
});

test('two quick changes both persist', async ({ page }) => {
	await openSheet(page, 'Gear Juggler', 'Pell Twohands');
	await addItem(page, 'Dagger');
	await addItem(page, 'Rope');
	const saved = savedWhere(
		page,
		(eq) => at(eq, 'weapon-dagger')?.location === 'hand' && at(eq, 'rope')?.location === 'belt'
	);
	await (await locationOf(page, 'Dagger')).selectOption('hand');
	await (await locationOf(page, 'Rope')).selectOption('belt');
	await saved;
	await page.reload();
	await expect(group(page, 'In hand').getByRole('listitem').filter({ hasText: 'Dagger' })).toBeVisible();
	await expect(group(page, 'Belt').getByRole('listitem').filter({ hasText: 'Rope' })).toBeVisible();
});

test('empty groups still render, and Gear appears once', async ({ page }) => {
	const gear = await openSheet(page, 'Gear Empty', 'Bare Bram');
	for (const label of ['In hand', 'Worn', 'Belt', 'Backpack']) {
		await expect(gear.getByRole('heading', { name: label, exact: true })).toBeVisible();
	}
	await expect(group(page, 'In hand')).toHaveAccessibleName(/2 open/);
	await expect(gear.getByText('empty', { exact: true })).toHaveCount(4);
	await addItem(page, 'Rope');
	await expect(page.getByRole('heading', { name: 'Gear', exact: true })).toHaveCount(1);
});

test('notches mark and repair durability in place', async ({ page }) => {
	await openSheet(page, 'Gear Notcher', 'Brannoc Fray');
	await addItem(page, 'Rope');
	const rope = group(page, 'Backpack').getByRole('listitem').filter({ hasText: 'Rope' });
	await expect(rope).toContainText('notches 0/2');
	const marked = savedWhere(page, (eq) => at(eq, 'rope')?.notchesTaken === 2);
	// Tapping the second box marks up to it.
	await rope.getByRole('button', { name: 'Notch Rope', exact: true }).nth(1).click();
	await expect(rope).toContainText('notches 2/2');
	await expect(rope).toContainText('Destroyed');
	await marked;
	// Tapping a marked box repairs from it.
	const repaired = savedWhere(page, (eq) => at(eq, 'rope')?.notchesTaken === 1);
	await rope.getByRole('button', { name: 'Repair a notch on Rope', exact: true }).nth(1).click();
	await expect(rope).toContainText('notches 1/2');
	await repaired;
	await page.reload();
	await expect(rope).toContainText('notches 1/2');
});

test('wound notches the item it names after a regroup', async ({ page }) => {
	await openSheet(page, 'Gear Wounded', 'Osk Shieldarm');
	await addItem(page, 'Rope');
	await addItem(page, 'Shield, Light');
	await addItem(page, 'Helm');
	await (await locationOf(page, 'Shield, Light')).selectOption('hand');
	const shield = group(page, 'In hand').getByRole('listitem').filter({ hasText: 'Shield, Light' });
	await expect(shield).toBeVisible();
	await page.getByRole('button', { name: 'Take a Wound…' }).click();
	// The wound option ("Notch Shield, Light 1 notch"), not the panel's own notch + button.
	await page.getByRole('button', { name: /^Notch Shield, Light .+/ }).click();
	await expect(shield).toContainText('notches 1/1');
	await expect(shield).toContainText('Destroyed');
	const backpack = group(page, 'Backpack');
	await expect(backpack.getByRole('listitem').filter({ hasText: 'Rope' })).toContainText('notches 0/2');
	await expect(backpack.getByRole('listitem').filter({ hasText: 'Helm' })).toContainText('notches 0/1');
	await expect(backpack.getByText('Destroyed')).toHaveCount(0);
});

test('Undo takes back the last gear change, and only that one', async ({ page }) => {
	const gear = await openSheet(page, 'Gear Canceller', 'Wren Secondthought');
	// The first change saves and stays.
	const ropeSaved = savedWhere(page, (equipment) => at(equipment, 'rope') !== undefined);
	await addItem(page, 'Rope');
	await ropeSaved;

	// The second is undone, whether or not its own save has landed yet.
	await addItem(page, 'Torch');
	const undone = savedWhere(page, (equipment) => at(equipment, 'torch') === undefined && at(equipment, 'rope') !== undefined);
	await page.getByRole('button', { name: 'Undo last change', exact: true }).click();
	await undone;
	await expect(gear.getByRole('listitem').filter({ hasText: 'Torch' })).toHaveCount(0);
	await expect(gear.getByRole('listitem').filter({ hasText: 'Rope' })).toHaveCount(1);
	await expect(page.getByRole('button', { name: 'Undo last change', exact: true })).toHaveCount(0);
	await page.reload();
	await expect(gear.getByRole('listitem').filter({ hasText: 'Torch' })).toHaveCount(0);
	await expect(gear.getByRole('listitem').filter({ hasText: 'Rope' })).toHaveCount(1);
});

test('details edited in place save without a Save button', async ({ page }) => {
	await openSheet(page, 'Gear Scribe', 'Odo Inkfinger');
	await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
	await page.getByRole('textbox', { name: 'Quest' }).fill('Map the drowned stair');
	await expect(page.locator('.save-state')).toHaveText('Saved');
	await page.reload();
	await expect(page.getByRole('textbox', { name: 'Quest' })).toHaveValue('Map the drowned stair');
});

test('narrow screen has no horizontal scroll', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await openSheet(page, 'Gear Narrow', 'Tam Slim');
	await addItem(page, 'Shield, Light');
	const backpack = group(page, 'Backpack');
	await expect(backpack).toBeVisible();
	await expect(backpack.locator('.slot')).toHaveCount(21);
	await backpack.scrollIntoViewIfNeeded();
	await expect(backpack.locator('.slot').last()).toBeInViewport();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

const BACKPACK_USED = /^Backpack: (\d+) of/;
async function backpackUsed(page: Page) {
	const name = (await group(page, 'Backpack').getAttribute('aria-label')) ?? '';
	return Number(BACKPACK_USED.exec(name)?.[1]);
}

test('adds a custom item', async ({ page }) => {
	const gear = await openSheet(page, 'Gear Custom', 'Ines Curio');
	const before = await backpackUsed(page);
	const toggle = gear.getByRole('button', { name: '+ Custom item' });
	await toggle.click();
	const form = gear.getByRole('form', { name: 'Custom item' });
	await expect(form).toBeVisible();
	await expect(toggle).toHaveAttribute('aria-controls', (await form.getAttribute('id')) ?? 'missing');
	await gear.getByLabel('Item name').fill('Jade idol');
	await gear.getByLabel('Slots', { exact: true }).fill('2');
	await gear.getByLabel('Max notches (optional)').fill('3');
	const saved = page.waitForResponse(
		(r) => r.request().method() === 'PUT' && r.url().includes('/api/characters/') && r.ok() &&
			(r.request().postData() ?? '').includes('Jade idol')
	);
	await gear.getByRole('button', { name: 'Add custom item' }).click();
	const row = group(page, 'Backpack').getByRole('listitem').filter({ hasText: 'Jade idol' });
	await expect(row).toContainText('notches 0/3');
	expect(await backpackUsed(page)).toBe(before + 2);
	await saved;
	await page.reload();
	await expect(group(page, 'Backpack').getByRole('listitem').filter({ hasText: 'Jade idol' })).toBeVisible();
	expect(await backpackUsed(page)).toBe(before + 2);
	const moved = page.waitForResponse(
		(r) => r.request().method() === 'PUT' && r.url().includes('/api/characters/') && r.ok() &&
			(r.request().postData() ?? '').includes('"worn"')
	);
	await (await locationOf(page, 'Jade idol')).selectOption('worn');
	await expect(group(page, 'Worn').getByRole('listitem').filter({ hasText: 'Jade idol' })).toBeVisible();
	expect(await backpackUsed(page)).toBe(before);
	await moved;
});

test('rejects bad custom item input, then a zero-slot trinket takes no room', async ({ page }) => {
	const gear = await openSheet(page, 'Gear Rejecter', 'Cass Badform');
	const before = await backpackUsed(page);
	const rows = gear.getByRole('listitem');
	await gear.getByRole('button', { name: '+ Custom item' }).click();
	await gear.getByRole('button', { name: 'Add custom item' }).click();
	await expect(gear.getByRole('alert')).toHaveText('Give the item a name.');
	await expect(rows).toHaveCount(0);
	await gear.getByLabel('Item name').fill('Odd thing');
	await gear.getByLabel('Slots', { exact: true }).fill('1.5');
	await gear.getByRole('button', { name: 'Add custom item' }).click();
	await expect(gear.getByRole('alert')).toContainText('Slots');
	await expect(rows).toHaveCount(0);
	await expect(gear.getByLabel('Item name')).toHaveValue('Odd thing');
	await expect(gear.getByLabel('Slots', { exact: true })).toHaveValue('1.5');
	// A blank number is not zero.
	await gear.getByLabel('Slots', { exact: true }).fill('');
	await gear.getByRole('button', { name: 'Add custom item' }).click();
	await expect(gear.getByRole('alert')).toContainText('Slots');
	await gear.getByLabel('Slots', { exact: true }).fill('1');
	await gear.getByLabel('Quantity', { exact: true }).fill('  ');
	await gear.getByRole('button', { name: 'Add custom item' }).click();
	await expect(gear.getByRole('alert')).toContainText('Quantity');
	await expect(rows).toHaveCount(0);
	await gear.getByLabel('Quantity', { exact: true }).fill('1');
	await gear.getByLabel('Item name').fill('Lucky button');
	await gear.getByLabel('Slots', { exact: true }).fill('0');
	await gear.getByRole('button', { name: 'Add custom item' }).click();
	await expect(group(page, 'Backpack').getByRole('listitem').filter({ hasText: 'Lucky button' })).toBeVisible();
	expect(await backpackUsed(page)).toBe(before);
});

test('keyboard focus and custom-item typing survive the autosave', async ({ page }) => {
	const gear = await openSheet(page, 'Gear Focus', 'Fenn Keeper');
	await addItem(page, 'Dagger');
	const saved = savedWhere(page, (eq) => at(eq, 'weapon-dagger')?.location === 'hand');
	const select = await locationOf(page, 'Dagger');
	await select.selectOption('hand');
	await expect(select).toBeFocused();
	await saved;
	await expect(select).toBeEnabled();
	await expect(select).toBeFocused();

	// A control that is not an item row (the market select) gets focus back too.
	const marketSaved = savedWhere(page, (eq) => at(eq, 'weapon-dagger')?.location === 'belt');
	await select.selectOption('belt');
	const market = gear.getByLabel('Add an item from the market');
	await market.focus();
	await marketSaved;
	await expect(market).toBeEnabled();
	await expect(market).toBeFocused();

	// Typing in the custom-item form is not cut off by the autosave of an
	// earlier change: the save lands mid-typing and every keystroke arrives.
	const typed = 'Brass compass';
	let savedMidTyping = false;
	const moveSaved = savedWhere(page, (eq) => at(eq, 'weapon-dagger')?.location === 'pack');
	void moveSaved.then(() => (savedMidTyping = true));
	// Slow the save down so "a save is in flight" is a window we can observe.
	await page.route('**/api/characters/*', async (route) => {
		if (route.request().method() === 'PUT') await new Promise((done) => setTimeout(done, 800));
		await route.continue();
	});
	await select.selectOption('pack');
	const toggle = gear.getByRole('button', { name: '+ Custom item' });
	await toggle.click();
	const nameField = gear.getByLabel('Item name');
	const addCustom = gear.getByRole('button', { name: 'Add custom item' });
	await nameField.pressSequentially(typed.slice(0, 5), { delay: 150 });
	// While that save is in flight the fields stay typable, but adding waits
	// (button and Enter alike), so the item cannot be lost to a resync.
	await expect(addCustom).toBeDisabled();
	await expect(nameField).toBeEnabled();
	await nameField.press('Enter');
	await expect(nameField).toBeVisible();
	await nameField.pressSequentially(typed.slice(5), { delay: 150 });
	await moveSaved;
	await page.unroute('**/api/characters/*');
	expect(savedMidTyping).toBe(true);
	await expect(addCustom).toBeEnabled();
	await expect(nameField).toHaveValue(typed);
	await expect(nameField).toBeFocused();
	const customSaved = page.waitForResponse(
		(r) => r.request().method() === 'PUT' && r.url().includes('/api/characters/') && r.ok() &&
			(r.request().postData() ?? '').includes(typed)
	);
	await gear.getByRole('button', { name: 'Add custom item' }).click();
	// The form closes; focus lands on the toggle that opened it.
	await expect(toggle).toBeFocused();
	await customSaved;
	await page.reload();
	await expect(group(page, 'Backpack').getByRole('listitem').filter({ hasText: typed })).toBeVisible();
});

test('a change made after the first save has started also persists', async ({ page }) => {
	await openSheet(page, 'Gear Twice', 'Odo Sequel');
	await addItem(page, 'Dagger');
	await addItem(page, 'Rope');
	const first = savedWhere(page, (eq) => at(eq, 'weapon-dagger')?.location === 'hand');
	await (await locationOf(page, 'Dagger')).selectOption('hand');
	await first;
	const second = savedWhere(
		page,
		(eq) => at(eq, 'weapon-dagger')?.location === 'hand' && at(eq, 'rope')?.location === 'belt'
	);
	await expect(await locationOf(page, 'Rope')).toBeEnabled();
	await (await locationOf(page, 'Rope')).selectOption('belt');
	await second;
	await page.reload();
	await expect(group(page, 'In hand').getByRole('listitem').filter({ hasText: 'Dagger' })).toBeVisible();
	await expect(group(page, 'Belt').getByRole('listitem').filter({ hasText: 'Rope' })).toBeVisible();
});

test('focus is not restored onto another item after Remove', async ({ page }) => {
	await openSheet(page, 'Gear Remover', 'Ward Dropper');
	await addItem(page, 'Dagger');
	await addItem(page, 'Rope');
	const saved = savedWhere(page, (eq) => eq.length === 1 && eq[0].itemId === 'rope');
	await openRow(page, 'Dagger');
	await page.getByRole('button', { name: 'Remove Dagger', exact: true }).click();
	await saved;
	// Focus parks on the market select, never inside the row that took the removed one's place.
	const rope = page.getByRole('region', { name: 'Gear', exact: true }).getByRole('listitem').filter({ hasText: 'Rope' });
	await expect(rope.locator('button.iname')).toBeEnabled();
	await expect(rope.locator(':focus')).toHaveCount(0);
});
