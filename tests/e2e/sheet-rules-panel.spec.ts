import { expect, test, type Page } from '@playwright/test';
import { signInAs, createTestAdventurer } from './fixtures/auth';

const WIDE = { width: 1440, height: 900 };
const NARROW = { width: 1024, height: 800 };
/** 84rem at the 16px media-query rem: the first width that shows the panel. */
const BREAKPOINT = { width: 1344, height: 900 };
/** Just under the breakpoint: the sheet could not keep 48rem beside a panel. */
const JUST_UNDER = { width: 1300, height: 900 };

const panelOf = (page: Page) => page.getByRole('complementary', { name: 'Rules reference' });
const panelSearch = (page: Page) =>
	panelOf(page).getByRole('combobox', { name: 'Search the rules beside the sheet', exact: true });

async function openSheet(page: Page, role: string, name: string) {
	await signInAs(page, role);
	const { id } = await createTestAdventurer(page, name);
	await page.goto(`/sheet/${id}`);
	return id;
}

/** Types into the panel search and opens the first result; returns its title. */
async function openFirstResult(page: Page, query: string) {
	const panel = panelOf(page);
	await panelSearch(page).fill(query);
	const first = panel.getByRole('listbox', { name: 'Rules search results' }).getByRole('option').first();
	await expect(first).toBeVisible();
	const title = ((await first.locator('.title').textContent()) ?? '').trim();
	await first.click();
	return title;
}

test('wide screen shows the panel and reads a rule in place', async ({ page }) => {
	await page.setViewportSize(WIDE);
	const id = await openSheet(page, 'Panel Reader', 'Wyn Readwell');
	const panel = panelOf(page);
	await expect(panel).toBeVisible();
	await expect(panel.getByText('Search the rules without leaving your sheet.')).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

	const title = await openFirstResult(page, 'wound');
	await expect(panel.getByRole('heading', { level: 3, name: title })).toBeVisible();
	await expect(panel.locator('article .body')).not.toBeEmpty();
	await expect(page).toHaveURL(new RegExp(`/sheet/${id}$`));
	await expect(page.getByRole('button', { name: 'Take a Wound…' })).toBeVisible();

	await panel.getByRole('button', { name: '← Results' }).click();
	await expect(panel.getByRole('listbox', { name: 'Rules search results' })).toBeVisible();
	await expect(panelSearch(page)).toHaveValue('wound');
});

test('a phrase search highlights the phrase without scrolling the page', async ({ page }) => {
	await page.setViewportSize(WIDE);
	await openSheet(page, 'Panel Phraser', 'Pip Phrasewell');
	await expect(panelOf(page)).toBeVisible();
	const before = await page.evaluate(() => window.scrollY);
	await openFirstResult(page, 'take a wound');
	const mark = panelOf(page).locator('article mark.phrase-hl').first();
	await expect(mark).toBeVisible();
	await expect(mark).toHaveText(/take a wound/i);
	expect(await page.evaluate(() => window.scrollY)).toBe(before);
	await expect(panelOf(page).getByRole('link', { name: 'Open in rules ↗' })).toHaveAttribute('href', /\?hl=take%20a%20wound#/);
});

test('open in rules link goes to the rules page in a new tab', async ({ page }) => {
	await page.setViewportSize(WIDE);
	await openSheet(page, 'Panel Linker', 'Ott Linkfoot');
	await openFirstResult(page, 'wound');
	const link = panelOf(page).getByRole('link', { name: 'Open in rules ↗' });
	await expect(link).toHaveAttribute('target', '_blank');
	await expect(link).toHaveAttribute('href', /^\/rules\//);
});

test('/ focuses the panel search on wide screens and the header search just under the breakpoint', async ({ page }) => {
	await page.setViewportSize(WIDE);
	await openSheet(page, 'Panel Slasher', 'Sly Slash');
	await expect(panelOf(page)).toBeVisible();
	// The shortcut is wired by hydration-time listeners; retry the keypress.
	await expect(async () => {
		await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
		await page.keyboard.press('/');
		await expect(panelSearch(page)).toBeFocused({ timeout: 200 });
	}).toPass();

	await page.setViewportSize(JUST_UNDER);
	await expect(panelOf(page)).toHaveCount(0);
	const header = page.getByRole('combobox', { name: 'Search the rules', exact: true });
	await expect(async () => {
		await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
		await page.keyboard.press('/');
		await expect(header).toBeFocused({ timeout: 200 });
	}).toPass();
});

test('no panel below 84rem and no horizontal scroll', async ({ page }) => {
	await page.setViewportSize(NARROW);
	await openSheet(page, 'Panel Narrow', 'Nim Narrowway');
	await expect(page.getByRole('button', { name: 'Take a Wound…' })).toBeVisible();
	await expect(panelOf(page)).toHaveCount(0);
	const { scrollWidth, innerWidth, sheetWidth, rem } = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		innerWidth: window.innerWidth,
		sheetWidth: document.querySelector('.sheet-page')!.getBoundingClientRect().width,
		rem: parseFloat(getComputedStyle(document.documentElement).fontSize)
	}));
	expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
	// The sheet keeps main's 48rem cap. The root font size is 18px here, so the
	// cap is 864px, not 768px.
	expect(sheetWidth).toBeLessThanOrEqual(48 * rem);
});

test('at the breakpoint the sheet keeps its full 48rem beside the panel', async ({ page }) => {
	await page.setViewportSize(BREAKPOINT);
	await openSheet(page, 'Panel Edge', 'Eda Edgeworth');
	await expect(panelOf(page)).toBeVisible();
	const { scrollWidth, innerWidth, colWidth, rem } = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		innerWidth: window.innerWidth,
		colWidth: document.querySelector('.sheet-col')!.getBoundingClientRect().width,
		rem: parseFloat(getComputedStyle(document.documentElement).fontSize)
	}));
	expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
	expect(colWidth).toBeCloseTo(48 * rem, 0);
});

test('panel state survives an autosave and a resize', async ({ page }) => {
	await page.setViewportSize(WIDE);
	await openSheet(page, 'Panel Keeper', 'Kes Keepsake');
	const title = await openFirstResult(page, 'wound');
	const heading = panelOf(page).getByRole('heading', { level: 3, name: title });
	await expect(heading).toBeVisible();

	const saved = page.waitForResponse(
		(r) => r.request().method() === 'PUT' && r.url().includes('/api/characters/') && r.ok()
	);
	await page.getByLabel('Staggered').check();
	await saved;
	await expect(heading).toBeVisible();

	await page.setViewportSize(NARROW);
	await expect(panelOf(page)).toHaveCount(0);
	await page.setViewportSize(WIDE);
	await expect(heading).toBeVisible();
	await expect(panelSearch(page)).toHaveValue('wound');
});

test('a rule that fails to load still offers a way out', async ({ page }) => {
	await page.setViewportSize(WIDE);
	await openSheet(page, 'Panel Offline', 'Fen Faileth');
	await page.route('**/api/rules/**', (route) => route.abort());
	await openFirstResult(page, 'wound');
	const panel = panelOf(page);
	await expect(panel.getByText('This rule could not be loaded.')).toBeVisible();
	await expect(panel.getByRole('button', { name: '← Results' })).toBeVisible();
	await expect(panel.getByRole('link', { name: 'Open in rules ↗' })).toHaveAttribute('href', /^\/rules\/[^#?]+/);
});

// In-rule links (/rules/<section>#<id>): the current content pack has no rule
// body containing such a link (no "](/rules/" in rules.json, and the markdown
// renderer does not emit anchors), so there is nothing to click end-to-end.
// The delegated click handler in RulesSidePanel.svelte is covered by review.
test.skip('a link to another rule opens in the panel', () => {});
