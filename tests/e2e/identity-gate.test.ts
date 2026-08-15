import { expect, test } from '@playwright/test';

test('identity step blocks continue without a name and re-blocks after erasing it', async ({
	page
}) => {
	await page.goto('/create/hmtw/identity');

	// Empty form: clicking Continue must explain itself, not advance.
	await page.getByRole('button', { name: 'Continue' }).click();
	await expect(page.getByRole('alert')).toHaveText('Give your adventurer a name to continue.');
	await expect(page).toHaveURL(/\/create\/hmtw\/identity$/);

	// Type a name, erase it: still blocked (the session-zero regression).
	const nameField = page.getByLabel('Name', { exact: true });
	await nameField.fill('Mara');
	await nameField.fill('');
	await page.getByRole('button', { name: 'Continue' }).click();
	await expect(page.getByRole('alert')).toHaveText('Give your adventurer a name to continue.');
	await expect(page).toHaveURL(/\/create\/hmtw\/identity$/);

	// A real name proceeds, and the error clears.
	await nameField.fill('Mara of the Lantern');
	await page.getByRole('button', { name: 'Continue' }).click();
	await expect(page).toHaveURL(/\/create\/hmtw\/kith$/);
});
