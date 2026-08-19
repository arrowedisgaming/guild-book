import { expect, test } from '@playwright/test';
import { signInAs, createTestAdventurer } from './fixtures/auth';

/**
 * Adding languages to an existing adventurer, end to end.
 *
 * What only a browser proves: the dropdown is filled from the content pack and
 * shrinks as tongues are learned, a hand-typed language survives the round trip
 * alongside a picked one, and both land on the rendered sheet after the save —
 * the sheet's edit session persists through a real PUT, not local state.
 */
test('a saved adventurer can learn a pack language and a custom one', async ({ page }) => {
	await signInAs(page, 'Linguist');
	const { id } = await createTestAdventurer(page, 'Sela of the Docks');

	await page.goto(`/sheet/${id}`);
	await page.getByRole('button', { name: 'Edit' }).click();

	const picker = page.getByLabel('Language', { exact: true });
	await expect(picker.locator('option', { hasText: 'Vulgaris' })).toHaveCount(1);

	await picker.selectOption({ label: 'Vulgaris' });
	await page.getByRole('button', { name: 'Add language' }).click();

	// Learned tongues leave the dropdown, so there is no way to add a duplicate.
	await expect(picker.locator('option', { hasText: 'Vulgaris' })).toHaveCount(0);

	await page.getByRole('textbox', { name: 'Custom language' }).fill('Dockhand Whistle-Cant');
	await page.getByRole('button', { name: 'Add custom language' }).click();

	await page.getByRole('button', { name: 'Save changes' }).click();

	// Back on the read-only sheet, both languages are rendered from the server.
	await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible();
	await expect(page.getByText('Languages: Vulgaris, Dockhand Whistle-Cant')).toBeVisible();

	// And they are still there on a cold load.
	await page.reload();
	await expect(page.getByText('Languages: Vulgaris, Dockhand Whistle-Cant')).toBeVisible();
});
