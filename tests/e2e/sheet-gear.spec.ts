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

async function addItem(page: Page, name: string) {
	const gear = page.getByRole('region', { name: 'Gear', exact: true });
	await gear.getByLabel('Add an item from the market').selectOption({ label: name });
	await gear.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(gear.getByRole('listitem').filter({ hasText: name })).toHaveCount(1);
}

const group = (page: Page, prefix: string) =>
	page
		.getByRole('region', { name: 'Gear', exact: true })
		.getByRole('region', { name: new RegExp(`^${prefix}`) });

test('moves gear without Edit mode and persists', async ({ page }) => {
	await openSheet(page, 'Gear Mover', 'Hilde Quickhand');
	await addItem(page, 'Dagger');
	const saved = savedWhere(page, (eq) => at(eq, 'weapon-dagger')?.location === 'hand');
	await page.getByLabel('Location of Dagger').selectOption('hand');
	// Focus follows the row into its new group.
	await expect(page.getByLabel('Location of Dagger')).toBeFocused();
	await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
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
	await page.getByLabel('Location of Dagger').selectOption('hand');
	await page.getByLabel('Location of Rope').selectOption('belt');
	await saved;
	await page.reload();
	await expect(group(page, 'In hand').getByRole('listitem').filter({ hasText: 'Dagger' })).toBeVisible();
	await expect(group(page, 'Belt').getByRole('listitem').filter({ hasText: 'Rope' })).toBeVisible();
});

test('empty groups still render', async ({ page }) => {
	const gear = await openSheet(page, 'Gear Empty', 'Bare Bram');
	for (const label of ['In hand', 'Worn', 'Belt', 'Backpack']) {
		await expect(gear.getByRole('heading', { name: label, exact: true })).toBeVisible();
	}
	await expect(group(page, 'In hand')).toHaveAccessibleName(/2 open/);
	await expect(gear.getByText('empty', { exact: true })).toHaveCount(4);
});

test('wound notches the item it names after a regroup', async ({ page }) => {
	await openSheet(page, 'Gear Wounded', 'Osk Shieldarm');
	await addItem(page, 'Rope');
	await addItem(page, 'Shield, Light');
	await addItem(page, 'Helm');
	await page.getByLabel('Location of Shield, Light').selectOption('hand');
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

test('Edit-mode Cancel reverts gear', async ({ page }) => {
	const gear = await openSheet(page, 'Gear Canceller', 'Wren Secondthought');
	await page.getByRole('button', { name: 'Edit', exact: true }).click();
	await addItem(page, 'Torch');
	await page.getByRole('button', { name: 'Cancel', exact: true }).click();
	await expect(gear.getByRole('listitem').filter({ hasText: 'Torch' })).toHaveCount(0);
	await page.reload();
	await expect(gear.getByRole('listitem').filter({ hasText: 'Torch' })).toHaveCount(0);
});

test('no Gear section duplicated', async ({ page }) => {
	await openSheet(page, 'Gear Single', 'Una Once');
	await addItem(page, 'Rope');
	await expect(page.getByRole('heading', { name: 'Gear', exact: true })).toHaveCount(1);
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
	await gear.getByRole('button', { name: '+ Custom item' }).click();
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
	await page.getByLabel('Location of Jade idol').selectOption('worn');
	await expect(group(page, 'Worn').getByRole('listitem').filter({ hasText: 'Jade idol' })).toBeVisible();
	expect(await backpackUsed(page)).toBe(before);
	await moved;
});

test('rejects bad custom item input', async ({ page }) => {
	const gear = await openSheet(page, 'Gear Rejecter', 'Cass Badform');
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
});

test('a zero-slot trinket takes no room', async ({ page }) => {
	const gear = await openSheet(page, 'Gear Trinket', 'Pip Tiny');
	const before = await backpackUsed(page);
	await gear.getByRole('button', { name: '+ Custom item' }).click();
	await gear.getByLabel('Item name').fill('Lucky button');
	await gear.getByLabel('Slots', { exact: true }).fill('0');
	await gear.getByRole('button', { name: 'Add custom item' }).click();
	await expect(group(page, 'Backpack').getByRole('listitem').filter({ hasText: 'Lucky button' })).toBeVisible();
	expect(await backpackUsed(page)).toBe(before);
});
