import { expect, test } from '@playwright/test';

test('public pages ship no X-Frame-Options so GM tools can embed the site', async ({ page }) => {
	const response = await page.goto('/');
	expect(response?.headers()['x-frame-options']).toBeUndefined();
	expect(response?.headers()['content-security-policy']).toBeUndefined();
	// The other hardening headers must survive the change.
	expect(response?.headers()['x-content-type-options']).toBe('nosniff');
	expect(response?.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin');
});

test('the home page actually renders inside a plain iframe', async ({ page, baseURL }) => {
	await page.setContent(
		`<iframe src="${baseURL}/" style="width: 800px; height: 600px;"></iframe>`
	);
	await expect(
		page.frameLocator('iframe').getByRole('heading', { name: 'Guild Book' })
	).toBeVisible();
});

test('private routes keep frame protection', async ({ request }) => {
	for (const path of ['/characters', '/campaigns', '/account', '/login']) {
		const response = await request.get(path, { maxRedirects: 0 });
		expect(response.headers()['x-frame-options'], `${path} X-Frame-Options`).toBe('DENY');
		expect(
			response.headers()['content-security-policy'],
			`${path} Content-Security-Policy`
		).toBe("frame-ancestors 'none'");
	}
});
