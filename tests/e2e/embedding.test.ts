import { expect, test } from '@playwright/test';

test('pages ship no X-Frame-Options so GM tools can embed the site', async ({ page }) => {
	const response = await page.goto('/');
	expect(response?.headers()['x-frame-options']).toBeUndefined();
	// The other hardening headers must survive the change.
	expect(response?.headers()['x-content-type-options']).toBe('nosniff');
	expect(response?.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin');
});
