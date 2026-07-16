import { test, expect } from '@playwright/test';

/**
 * The /deck tool is the resolution engine's reference client, so this drives the
 * real rules end to end.
 *
 * Every seed below was chosen by computing what it actually draws, not by naming
 * it after the outcome we want:
 *   e2e-0   → Wands III (3), then Cups VII
 *   e2e-3   → Page of Pentacles (11)
 *   e2e-8   → the Fool first
 *   e2e-330 → Wands II (2), then the Fool
 */
async function openTestOfFate(page: import('@playwright/test').Page, seed: string) {
	await page.goto(`/deck?seed=${seed}`);
	await page.getByRole('tab', { name: 'Test of fate' }).click();
}

test.describe('test of fate', () => {
	test('a seeded draw is deterministic and resolves a failure that can be pushed', async ({
		page
	}) => {
		await openTestOfFate(page, 'e2e-0');
		await page.getByRole('button', { name: 'Cups' }).click();
		await page.getByLabel('Attribute').selectOption('1');
		await page.getByRole('button', { name: 'Draw & test' }).click();

		// Wands III (3) + attribute 1 = 4 → failure, and a free push remains.
		await expect(page.locator('.result')).toHaveAttribute('data-total', '4');
		await expect(page.locator('.result')).toHaveAttribute('data-outcome', 'failure');
		await expect(page.getByRole('button', { name: 'Push fate (+1 card)' })).toBeEnabled();
	});

	test('favor adds +3 and disfavor cancels it, declared before the draw', async ({ page }) => {
		await openTestOfFate(page, 'e2e-0');
		await page.getByRole('button', { name: 'Cups' }).click();
		await page.getByLabel('Attribute').selectOption('1');
		await page.getByLabel('Favor', { exact: true }).check();
		await page.getByRole('button', { name: 'Draw & test' }).click();

		// Wands III (3) + attribute 1 + 3 favor = 7.
		await expect(page.locator('.result')).toHaveAttribute('data-total', '7');

		// Ch1: favor and disfavor cancel. Both declared up front.
		await page.getByRole('button', { name: 'Clear' }).click();
		await page.getByLabel('Disfavor', { exact: true }).check();
		await page.getByRole('button', { name: 'Draw & test' }).click();
		await expect(page.locator('.result')).toHaveAttribute('data-total', '4');
	});

	/**
	 * The declaration is frozen once a card is visible. An earlier version of this
	 * suite checked Favor *after* drawing — codifying a sequence Ch1 forbids, and
	 * one that lets a player switch to the drawn suit to manufacture a great
	 * success. The engine cannot catch it; it only sees the final declaration.
	 */
	test('locks the declaration once a card is visible', async ({ page }) => {
		await openTestOfFate(page, 'e2e-0');
		await page.getByRole('button', { name: 'Cups' }).click();
		await page.getByLabel('Attribute').selectOption('1');
		await page.getByRole('button', { name: 'Draw & test' }).click();

		await expect(page.getByRole('button', { name: 'Wands' })).toBeDisabled();
		await expect(page.getByLabel('Attribute')).toBeDisabled();
		await expect(page.getByLabel('Favor', { exact: true })).toBeDisabled();
		await expect(page.getByLabel('Disfavor', { exact: true })).toBeDisabled();
		await expect(page.getByLabel('Spend 1 Resolve for favor')).toBeDisabled();
		await expect(page.getByRole('button', { name: 'Draw & test' })).toBeDisabled();

		// Clearing starts a fresh declaration.
		await page.getByRole('button', { name: 'Clear' }).click();
		await expect(page.getByRole('button', { name: 'Wands' })).toBeEnabled();
		await expect(page.getByLabel('Attribute')).toBeEnabled();
		await expect(page.getByLabel('Favor', { exact: true })).toBeEnabled();
		await expect(page.getByLabel('Disfavor', { exact: true })).toBeEnabled();
		await expect(page.getByLabel('Spend 1 Resolve for favor')).toBeEnabled();
		await expect(page.getByRole('button', { name: 'Draw & test' })).toBeEnabled();
	});

	test('spending Resolve buys favor and does not stack with it', async ({ page }) => {
		await openTestOfFate(page, 'e2e-0');
		await page.getByRole('button', { name: 'Cups' }).click();
		await page.getByLabel('Attribute').selectOption('1');
		// Ch1: Resolve is spent *prior* to the test, so it is declared up front.
		await page.getByLabel('Spend 1 Resolve for favor').check();
		await page.getByLabel('Favor', { exact: true }).check();
		await page.getByRole('button', { name: 'Draw & test' }).click();

		// Non-cumulative: two sources of favor still yield one +3.
		await expect(page.locator('.result')).toHaveAttribute('data-total', '7');
		await expect(page.locator('.result')).toContainText('1 Resolve');
		await expect(page.locator('.result')).toContainText('not cumulative');
	});

	test('pushing into the Fool is an automatic great failure', async ({ page }) => {
		await openTestOfFate(page, 'e2e-330');
		await page.getByRole('button', { name: 'Cups' }).click();
		await page.getByLabel('Attribute').selectOption('1');
		await page.getByRole('button', { name: 'Draw & test' }).click();
		await expect(page.locator('.result')).toHaveAttribute('data-outcome', 'failure');

		await page.getByRole('button', { name: 'Push fate (+1 card)' }).click();
		await expect(page.locator('.result')).toHaveAttribute('data-outcome', 'great-failure');
		await expect(page.locator('.result')).toContainText('automatic great failure');
		await expect(page.locator('.result')).toContainText('shuffle both decks');
	});

	test('an initial Fool fails at 0 but remains pushable', async ({ page }) => {
		await openTestOfFate(page, 'e2e-8');
		await page.getByRole('button', { name: 'Wands' }).click();
		await page.getByLabel('Attribute').selectOption('4');
		await page.getByRole('button', { name: 'Draw & test' }).click();

		// The Fool is 0, so the total is the attribute alone.
		await expect(page.locator('.result')).toHaveAttribute('data-total', '4');
		await expect(page.locator('.result')).toHaveAttribute('data-outcome', 'failure');
		await expect(page.locator('.result')).toContainText('shuffle both decks');
		await expect(page.getByRole('button', { name: 'Push fate (+1 card)' })).toBeEnabled();
	});

	test('a matching initial suit great-succeeds and cannot be pushed', async ({ page }) => {
		await openTestOfFate(page, 'e2e-3');
		await page.getByRole('button', { name: 'Pentacles' }).click();
		await page.getByLabel('Attribute').selectOption('4');
		await page.getByRole('button', { name: 'Draw & test' }).click();

		// Page of Pentacles (11) + 4 = 15, on the tested suit, with no push.
		await expect(page.locator('.result')).toHaveAttribute('data-total', '15');
		await expect(page.locator('.result')).toHaveAttribute('data-outcome', 'great-success');
		await expect(page.getByRole('button', { name: 'Push fate (+1 card)' })).toBeDisabled();
	});

	test('the same card off-suit is only a success', async ({ page }) => {
		await openTestOfFate(page, 'e2e-3');
		await page.getByRole('button', { name: 'Cups' }).click();
		await page.getByLabel('Attribute').selectOption('4');
		await page.getByRole('button', { name: 'Draw & test' }).click();

		await expect(page.locator('.result')).toHaveAttribute('data-total', '15');
		await expect(page.locator('.result')).toHaveAttribute('data-outcome', 'success');
	});
});
