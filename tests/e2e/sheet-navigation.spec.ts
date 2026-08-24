import { expect, test } from '@playwright/test';
import { signInAs, createTestAdventurer } from './fixtures/auth';

/**
 * Client-side navigation between two adventurer sheets.
 *
 * SvelteKit reuses the sheet component when only the [id] param changes, and
 * two adventurers can share a version number. The page's resync guard must
 * therefore key on the character id, not just the version — otherwise the
 * working copy keeps the PREVIOUS adventurer and the next auto-save writes
 * them wholesale over the one on screen.
 *
 * page.goto() performs full document loads (a fresh mount every time), so the
 * reused-component path is driven the way a user reaches it: an in-app link,
 * which the client router intercepts.
 */
test('navigating between same-version sheets never crosses their data', async ({ page }) => {
	await signInAs(page, 'Navigator');
	const one = await createTestAdventurer(page, 'Navi One');
	const two = await createTestAdventurer(page, 'Navi Two');
	expect(one.version).toBe(two.version); // the premise the id guard exists for

	await page.goto(`/sheet/${one.id}`);
	await expect(page.getByRole('heading', { name: 'Navi One' })).toBeVisible();

	// Same-route client-side navigation: an in-app link from sheet one to
	// sheet two, intercepted by the router, reusing the mounted component.
	await page.evaluate((id) => {
		const a = document.createElement('a');
		a.href = `/sheet/${id}`;
		a.textContent = 'next sheet';
		a.setAttribute('data-testid', 'next-sheet');
		document.querySelector('main')?.appendChild(a);
	}, two.id);
	await page.getByTestId('next-sheet').click();
	await expect(page.getByRole('heading', { name: 'Navi Two' })).toBeVisible();

	// An edit on the second sheet must save the SECOND adventurer's data. With
	// a stale working copy this PUT would carry 'Navi One' wholesale, so the
	// matcher would never resolve.
	const saved = page.waitForResponse((res) => {
		if (!res.url().includes(`/api/characters/${two.id}`)) return false;
		if (res.request().method() !== 'PUT' || !res.ok()) return false;
		const body = res.request().postDataJSON() as {
			character: { name: string; bonds: { targetName: string }[] };
		};
		return (
			body.character.name === 'Navi Two' &&
			body.character.bonds.some((b) => b.targetName === 'Grendel')
		);
	});
	await page.getByPlaceholder("Guild-mate's name").fill('Grendel');
	await page.getByRole('button', { name: 'Add bond' }).click();
	await saved;

	// Both adventurers still hold their own data on a cold load. Bond rows
	// carry the "Guild-mate's name" aria-label; the add-row input only has it
	// as a placeholder, so this matches saved bonds alone.
	await page.goto(`/sheet/${two.id}`);
	await expect(page.getByRole('heading', { name: 'Navi Two' })).toBeVisible();
	await expect(page.getByLabel("Guild-mate's name")).toHaveValue('Grendel');
	await page.goto(`/sheet/${one.id}`);
	await expect(page.getByRole('heading', { name: 'Navi One' })).toBeVisible();
	await expect(page.getByLabel("Guild-mate's name")).toHaveCount(0);
});
