import { expect, test } from '@playwright/test';
import { signInAs } from './fixtures/auth';

/**
 * The creation market's luxurious allowance, including the talent-required
 * escape hatch that used to leak.
 *
 * Path of Wands grants Gramarye, whose required Wand of Archwood is LUXURIOUS.
 * Required items are exempt from the tier allowance ("impoverished for you"),
 * and that exemption used to carry no limit of its own: the wand's "+" was the
 * one stepper on the page with no cap, so an adventurer could leave creation
 * with an arbitrary stack of a luxurious item while the counter read 0 / 1.
 */
test('creation caps luxurious picks, talent-required items included', async ({ page }) => {
	await signInAs(page, 'Market Wizard');
	await page.goto('/create/hmtw/identity');
	// The wizard rehydrates its store from localStorage after mount and rewrites
	// the fields, so a fill that lands first is wiped. Re-fill until it sticks.
	const name = page.getByLabel('Name', { exact: true });
	await expect(async () => {
		await name.fill('Wanda of the Wands');
		await expect(name).toHaveValue('Wanda of the Wands', { timeout: 1000 });
	}).toPass();
	await page.getByLabel('Appearance').fill('Ash-stained sleeves and a wand of pale wood.');
	await page.getByRole('button', { name: 'Continue' }).click();
	await expect(page).toHaveURL(/\/create\/hmtw\/kith$/);
	await page.getByRole('radio', { name: 'Humans' }).click();
	await page.getByRole('radio', { name: 'A Noble House' }).click();
	await page.getByRole('button', { name: 'Continue' }).click();
	await page.getByRole('radio', { name: 'Path of Wands' }).click();
	await page.getByRole('button', { name: 'Continue' }).click();
	await page.getByRole('radiogroup', { name: 'Swords value' }).getByRole('radio', { name: '3' }).click();
	await page.getByRole('radiogroup', { name: 'Cups value' }).getByRole('radio', { name: '2' }).click();
	await page.getByRole('radiogroup', { name: 'Pentacles value' }).getByRole('radio', { name: '1' }).click();
	await page.getByRole('button', { name: 'Continue' }).click();
	await page.getByRole('button', { name: 'Continue' }).click(); // talents: keep the seeded mastery
	await page.getByRole('button', { name: 'Continue' }).click(); // story
	await page.getByRole('button', { name: 'Continue' }).click(); // bonds
	await expect(page.getByRole('heading', { name: 'The Omphalic Market' })).toBeVisible();

	const required = page
		.locator('section')
		.filter({ has: page.getByRole('heading', { name: /talents need these/ }) });
	const luxurious = page
		.locator('section')
		.filter({ has: page.getByRole('heading', { name: /^Luxurious/ }) });
	const luxuriousCount = luxurious.locator('.count').first();

	// Gramarye's wand is luxurious and required, so it opens exempt at 0 / 1.
	await expect(luxuriousCount).toHaveText('0 / 1');
	await required.getByRole('checkbox', { name: 'Wand of Archwood' }).click();
	await expect(luxuriousCount).toHaveText('0 / 1');

	// One pick is all the exemption buys — the stepper stops at a single wand.
	await expect(required.getByRole('button', { name: 'Add another Wand of Archwood' })).toBeDisabled();
	await expect(required.locator('.qnum').first()).toHaveText('×1');

	// The allowance itself is still the player's to spend, and still just one.
	await luxurious.getByRole('checkbox', { name: 'Lantern' }).click();
	await expect(luxuriousCount).toHaveText('1 / 1');
	await expect(luxurious.getByRole('button', { name: 'Add another Lantern' })).toBeDisabled();
	await expect(
		luxurious.locator('.item.disabled').first().getByRole('checkbox')
	).toHaveAttribute('aria-label', /unavailable because the tier limit is reached/);

	// The cap survives the trip to review and back.
	await page.getByRole('button', { name: 'Continue' }).click();
	await expect(page).toHaveURL(/review$/);
	await expect(page.getByRole('listitem').filter({ hasText: 'Wand of Archwood' })).toBeVisible();
	await page.getByRole('link', { name: '← Back' }).click();
	await expect(luxuriousCount).toHaveText('1 / 1');
	await expect(required.getByRole('button', { name: 'Add another Wand of Archwood' })).toBeDisabled();
});
