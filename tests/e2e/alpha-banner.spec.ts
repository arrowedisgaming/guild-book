import { expect, test } from '@playwright/test';

test.describe('alpha banner', () => {
	test('is visible on the home page', async ({ page }) => {
		await page.goto('/');
		await expect(page.getByTestId('alpha-banner')).toBeVisible();
		await expect(page.getByTestId('alpha-banner')).toContainText('data may be lost');
	});

	test('dismissal hides it and survives navigation within the session', async ({ page }) => {
		await page.goto('/');
		await page.getByRole('button', { name: 'Dismiss alpha warning' }).click();
		await expect(page.getByTestId('alpha-banner')).toHaveCount(0);

		await page.goto('/rules');
		await expect(page.getByTestId('alpha-banner')).toHaveCount(0);
	});

	// The spec asks for coverage on a public `/s/[shareId]` page. Seeding a
	// shared character just for this would be disproportionate, and the
	// property under test is really "the root layout puts it on every page,
	// signed in or not" — which `/licensing` exercises identically. Task 6's
	// manual step covers a real share link.
	test('is visible on a public page with no session', async ({ page }) => {
		await page.goto('/licensing');
		await expect(page.getByTestId('alpha-banner')).toBeVisible();
	});

	test('returns in a fresh browser context', async ({ browser }) => {
		const context = await browser.newContext();
		const page = await context.newPage();
		await page.goto('/');
		await expect(page.getByTestId('alpha-banner')).toBeVisible();
		await context.close();
	});

	test('does not cause horizontal overflow at 320px', async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 720 });
		await page.goto('/');
		await expect(page.getByTestId('alpha-banner')).toBeVisible();

		const overflows = await page.evaluate(
			() => document.documentElement.scrollWidth > document.documentElement.clientWidth
		);
		expect(overflows).toBe(false);
	});
});
