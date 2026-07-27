import { expect, test } from '@playwright/test';

test.describe('error page', () => {
	test('renders a branded 404 with a way back', async ({ page }) => {
		const response = await page.goto('/this-route-does-not-exist');
		expect(response?.status()).toBe(404);

		await expect(page.getByTestId('error-page')).toBeVisible();
		await expect(page.getByTestId('error-status')).toContainText('404');
		await expect(page.getByRole('link', { name: 'Back to Guild Book' })).toBeVisible();
	});
});
