import { expect, test } from '@playwright/test';
import { signInAs } from './fixtures/auth';

test('signed-in adventurer completes, resumes, reviews, and saves the full wizard flow', async ({
	page
}) => {
	await signInAs(page, 'Wizard Release User');
	await page.goto('/create/hmtw/identity');
	await page.getByLabel('Name', { exact: true }).fill('Mara of the Lantern');
	await page.getByLabel('Pronouns').fill('she/her');
	await page.getByLabel('Appearance').fill('A travel-stained red cloak and a silver lantern.');
	await page.getByRole('button', { name: 'Continue' }).click();

	await page.getByRole('radio', { name: 'Humans' }).click();
	await page.getByRole('radio', { name: 'A Noble House' }).click();
	await page.getByRole('button', { name: 'Continue' }).click();

	await page.getByRole('radio', { name: 'Path of Pentacles' }).click();
	await page.getByRole('button', { name: 'Continue' }).click();

	await page.getByRole('radiogroup', { name: 'Swords value' }).getByRole('radio', { name: '3' }).click();
	await page.getByRole('radiogroup', { name: 'Cups value' }).getByRole('radio', { name: '2' }).click();
	await page.getByRole('radiogroup', { name: 'Wands value' }).getByRole('radio', { name: '1' }).click();
	await page.getByRole('button', { name: 'Continue' }).click();

	await expect(page).toHaveURL(/\/create\/hmtw\/talents$/);
	await page.reload();
	await expect(page).toHaveURL(/\/create\/hmtw\/talents$/);
	await expect(page.getByRole('heading', { name: 'Talents', exact: true })).toBeVisible();
	await expect(page.getByRole('radio').first()).toBeChecked();
	await page.getByRole('button', { name: 'Continue' }).click();

	await page.getByLabel('Quest').fill('Recover the bell beneath the drowned abbey.');
	await page.locator('.motifs input').first().fill('Disgraced Soldier');
	await page.getByRole('button', { name: 'Continue' }).click();

	await expect(page.getByRole('heading', { name: 'The Omphalic Market' })).toBeVisible();
	await page.getByRole('checkbox').first().click();
	await page.getByRole('button', { name: 'Continue' }).click();

	await expect(page).toHaveURL(/\/create\/hmtw\/review$/);
	await expect(page.getByRole('heading', { name: 'Mara of the Lantern' })).toBeVisible();
	await expect(page.getByText('A Noble House (Humans)')).toBeVisible();
	await expect(page.getByText('Path of Pentacles')).toBeVisible();
	await expect(page.getByText('Recover the bell beneath the drowned abbey.')).toBeVisible();
	await expect(page.getByText('Disgraced Soldier')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Save adventurer' })).toBeEnabled();

	await page.getByRole('button', { name: 'Save adventurer' }).click();
	await expect(page).toHaveURL(/\/characters$/);
	await expect(page.getByText('Mara of the Lantern')).toBeVisible();
	expect(await page.evaluate(() => localStorage.getItem('guildbook-wizard-state'))).toBeNull();
});

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

test('anonymous wizard review downloads the local draft without signing in', async ({ page }) => {
	await page.addInitScript(() => {
		localStorage.setItem(
			'guildbook-wizard-state',
			JSON.stringify({
				version: 1,
				active: true,
				currentStep: 7,
				completedSteps: [0, 1, 2, 3, 4, 5, 6],
				nonce: 0,
				character: { name: 'Anonymous Knight' }
			})
		);
	});

	await page.goto('/create/hmtw/review');
	await expect(page.getByText('These downloads work without an account.')).toBeVisible();

	const markdownDownload = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Download Markdown' }).click();
	expect((await markdownDownload).suggestedFilename()).toBe('anonymous-knight.md');
	await expect(page).toHaveURL(/\/create\/hmtw\/review$/);
});
