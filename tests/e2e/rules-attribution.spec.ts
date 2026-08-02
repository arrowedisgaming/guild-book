import { expect, test } from '@playwright/test';

const LICENSE_URL = 'https://www.hismajestytheworm.games/open-license';
const PURCHASE_URL = 'https://www.hismajestytheworm.games/his-majesty-the-worm';

test.describe('rulebook attribution card', () => {
	test('is on the rules index with both links intact', async ({ page }) => {
		await page.goto('/rules');
		const card = page.getByTestId('rulebook-thanks');
		await expect(card).toBeVisible();
		await expect(
			card.getByRole('heading', { name: 'With thanks to Josh McCrowell' })
		).toBeVisible();
		// The two hrefs are the assertions that matter: copy drift is cosmetic,
		// but a broken purchase link is the one failure with a real cost, and it
		// is exactly what a careless find-and-replace breaks silently.
		await expect(card.getByRole('link', { name: 'licensed the game' })).toHaveAttribute(
			'href',
			LICENSE_URL
		);
		await expect(card.getByRole('link', { name: 'His Majesty the Worm' })).toHaveAttribute(
			'href',
			PURCHASE_URL
		);
	});

	test('is on a chapter page', async ({ page }) => {
		await page.goto('/rules/city-phase');
		const card = page.getByTestId('rulebook-thanks');
		await expect(card).toBeVisible();
		await expect(card.getByRole('link', { name: 'His Majesty the Worm' })).toHaveAttribute(
			'href',
			PURCHASE_URL
		);
	});

	test('survives the empty-search state', async ({ page }) => {
		// The index swaps its whole body between results, "no match", and the
		// TOC. The card lives outside that switch and must show on all three.
		await page.goto('/rules?q=zzzznotarule');
		await expect(page.getByText('No rules match')).toBeVisible();
		await expect(page.getByTestId('rulebook-thanks')).toBeVisible();
	});

	test('opens both links in a new tab, safely', async ({ page }) => {
		await page.goto('/rules');
		const card = page.getByTestId('rulebook-thanks');
		for (const name of ['licensed the game', 'His Majesty the Worm']) {
			const link = card.getByRole('link', { name });
			await expect(link).toHaveAttribute('target', '_blank');
			await expect(link).toHaveAttribute('rel', /noopener/);
		}
	});

	test('does not cause horizontal overflow at 320px', async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 720 });
		await page.goto('/rules/city-phase');
		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		);
		expect(overflow).toBeLessThanOrEqual(0);
		await expect(page.getByTestId('rulebook-thanks')).toBeVisible();
	});
});
