import { expect, test } from '@playwright/test';

test('wizard assigns unique attributes and exposes standard theme controls', async ({ page }) => {
	await page.goto('/create/hmtw/identity');
	await page.getByLabel('Name', { exact: true }).fill('CI Adventurer');
	await page.getByRole('button', { name: 'Continue' }).click();

	await page.getByRole('radio', { name: 'Humans' }).click();
	await page.getByRole('radio', { name: 'A Noble House' }).click();
	await page.getByRole('button', { name: 'Continue' }).click();

	await page.getByRole('radio', { name: 'Path of Pentacles' }).click();
	await page.getByRole('button', { name: 'Continue' }).click();

	const swords = page.getByRole('radiogroup', { name: 'Swords value' });
	const cups = page.getByRole('radiogroup', { name: 'Cups value' });
	const wands = page.getByRole('radiogroup', { name: 'Wands value' });
	await swords.getByRole('radio', { name: '3' }).click();
	await expect(cups.getByRole('radio', { name: '3' })).toBeDisabled();
	await expect(wands.getByRole('radio', { name: '3' })).toBeDisabled();

	await cups.getByRole('radio', { name: '2' }).click();
	await wands.getByRole('radio', { name: '1' }).click();
	await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();

	const themeToggle = page.getByRole('button', { name: 'Switch to dark mode' });
	await expect(themeToggle.locator('svg.lucide-moon')).toBeVisible();
	await themeToggle.click();
	await expect(page.getByRole('button', { name: 'Switch to light mode' }).locator('svg.lucide-sun')).toBeVisible();

	await expect(page.locator('footer img')).toHaveCount(0);
	await page.goto('/licensing');
	await expect(page.getByAltText('Adherent of His Majesty the Worm')).toHaveCount(1);
});
