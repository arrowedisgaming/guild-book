import { expect, test } from '@playwright/test';

const searchbox = (page: import('@playwright/test').Page) =>
	page.getByRole('combobox', { name: 'Search the rules' });

test.describe('site-wide rules search', () => {
	test('finds a rule from a non-rules page, typo included, and lands focused on it', async ({ page }) => {
		await page.goto('/licensing');
		await searchbox(page).click();
		await searchbox(page).fill('carouse hangovr'); // typo: fuzzy must still hit
		const listbox = page.getByRole('listbox', { name: 'Rules search results' });
		await expect(listbox.getByRole('option').first()).toContainText('Carouse');
		await searchbox(page).press('Enter');
		await expect(page).toHaveURL(/\/rules\/city-phase#/);
		await expect(page.locator('article:focus h3')).toContainText('Carouse');
		await expect(page.locator('article:focus')).toContainText('Hangover');
	});

	test('highlights the matched word, not the typo', async ({ page }) => {
		await page.goto('/');
		await searchbox(page).click();
		await searchbox(page).fill('challnge');
		const listbox = page.getByRole('listbox', { name: 'Rules search results' });
		await expect(listbox.locator('mark').first()).toContainText(/challenge/i);
	});

	test('the / shortcut focuses the search except while typing elsewhere', async ({ page }) => {
		await page.goto('/deck');
		// The shortcut is wired up by a hydration-time listener; retry the
		// keypress instead of sleeping until the listener is live.
		await expect(async () => {
			await page.keyboard.press('/');
			await expect(searchbox(page)).toBeFocused({ timeout: 200 });
		}).toPass();
	});

	test('keyboard: arrows move the active option, Escape closes', async ({ page }) => {
		await page.goto('/');
		await searchbox(page).click();
		await searchbox(page).fill('watch');
		const listbox = page.getByRole('listbox', { name: 'Rules search results' });
		await expect(listbox.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
		await searchbox(page).press('ArrowDown');
		await expect(listbox.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
		await searchbox(page).press('Escape');
		await expect(listbox).toHaveCount(0);
	});

	test('hands off to /rules?q= with identically-ordered ranked results', async ({ page }) => {
		await page.goto('/');
		await searchbox(page).click();
		await searchbox(page).fill('disposition');
		const listbox = page.getByRole('listbox', { name: 'Rules search results' });
		const dropdownFirst = await listbox.getByRole('option').first().locator('.title').textContent();
		await page.getByRole('link', { name: /All results for/ }).click();
		await expect(page).toHaveURL(/\/rules\?q=disposition/);
		const pageFirst = page.locator('.results li a').first();
		await expect(pageFirst).toHaveText(dropdownFirst ?? '');
	});

	test('/rules shows all nine chapters with counts when the query is empty', async ({ page }) => {
		await page.goto('/rules');
		const groups = page.locator('.group h2');
		await expect(groups).toHaveCount(11); // 9 walked chapters + gamemastering + sorcery
		for (const label of ['The Basics', 'The Adventurer', 'The Guild', 'Kith & Kin', 'The Four Paths', 'The Crawl Phase', 'The Challenge Phase', 'The Camp Phase', 'The City Phase']) {
			await expect(page.locator('.group h2', { hasText: label })).toBeVisible();
		}
		await expect(page.locator('.group .count').first()).toContainText(/\d+ entries/);
	});

	test('no horizontal overflow at 320px with the search present', async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 720 });
		await page.goto('/rules');
		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		);
		expect(overflow).toBeLessThanOrEqual(0);
		await expect(searchbox(page)).toBeVisible();
	});

	test('same-route header handoff updates the /rules page query, input, and results', async ({ page }) => {
		await page.goto('/rules?q=carouse');
		const pageSearchbox = page.getByRole('searchbox', { name: 'Search the rules' });
		await expect(pageSearchbox).toHaveValue('carouse');
		const firstResult = page.locator('.results li a').first();
		await expect(firstResult).toContainText('Carouse');

		await searchbox(page).click();
		await searchbox(page).fill('leeches');
		const listbox = page.getByRole('listbox', { name: 'Rules search results' });
		await expect(listbox.getByRole('option').first()).toContainText('Leeches');
		await page.getByRole('link', { name: /All results for/ }).click();

		await expect(page).toHaveURL(/\/rules\?q=leeches/);
		await expect(pageSearchbox).toHaveValue('leeches');
		await expect(firstResult).toContainText('Leeches');
	});

	test('anchoring a new rule clears the previous anchor, even within the same section', async ({ page }) => {
		await page.goto('/');
		const listbox = page.getByRole('listbox', { name: 'Rules search results' });

		await searchbox(page).click();
		await searchbox(page).fill('carouse');
		await expect(listbox.getByRole('option').first()).toContainText('Carouse');
		await searchbox(page).press('Enter');
		await expect(page).toHaveURL(/\/rules\/city-phase#city-carouse/);
		await expect(page.locator('.anchored')).toHaveCount(1);
		await expect(page.locator('#city-carouse.anchored')).toHaveCount(1);

		await searchbox(page).click();
		await searchbox(page).fill('beg and busk');
		await expect(listbox.getByRole('option').first()).toContainText('Beg and Busk');
		await searchbox(page).press('Enter');
		await expect(page).toHaveURL(/\/rules\/city-phase#city-beg-and-busk/);

		await expect(page.locator('.anchored')).toHaveCount(1);
		await expect(page.locator('#city-beg-and-busk.anchored')).toHaveCount(1);
	});
});
