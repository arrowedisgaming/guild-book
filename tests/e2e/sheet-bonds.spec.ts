import { expect, test } from '@playwright/test';
import { signInAs, createTestAdventurer } from './fixtures/auth';

/**
 * Bond charge conditions on the adventurer sheet.
 *
 * What only a browser proves: naming the Bond type on an existing sheet surfaces
 * the book's charge condition for it, a two-sided Bond shows BOTH sides, and the
 * choice survives the save — the panel's debounced auto-save, not edit mode.
 */
test('a bond on the sheet shows the book’s charge conditions', async ({ page }) => {
	await signInAs(page, 'Bondsmith');
	const { id } = await createTestAdventurer(page, 'Sela of the Docks');

	await page.goto(`/sheet/${id}`);

	// The status panel saves on a debounce; each step waits for its own PUT so
	// the reloads below read what the server actually stored.
	const saved = () =>
		page.waitForResponse(
			(res) =>
				res.url().includes(`/api/characters/${id}`) &&
				res.request().method() === 'PUT' &&
				res.ok()
		);

	await page.getByPlaceholder("Guild-mate's name").fill('Grendel');
	await page.getByRole('button', { name: 'Add bond' }).click();

	const bondType = page.getByLabel('Bond type');
	await expect(bondType).toHaveValue('');

	await bondType.selectOption('Rival');
	await expect(page.getByText('Charge this Bond when you witness your rival succeed on a test of fate.')).toBeVisible();

	// A two-sided Bond quotes both halves, not just the first.
	await bondType.selectOption('Mentor/Mentee');
	await expect(page.getByText('Mentees charge this Bond when they ask the mentor for advice and it is given.')).toBeVisible();
	await expect(page.getByText('Mentors charge this Bond when a mentee follows their advice.')).toBeVisible();

	// The choice and its charge lines survive a reload.
	await saved();
	await page.reload();
	await expect(page.getByLabel('Bond type')).toHaveValue('Mentor/Mentee');
	await expect(page.getByText('Mentors charge this Bond when a mentee follows their advice.')).toBeVisible();

	// A bond in the player's own words keeps its text and offers no charge line.
	await page.getByLabel('Bond type').selectOption({ label: 'Something else…' });
	await page.getByLabel('Bond in your own words').fill('drinking buddies');
	await saved();
	await page.reload();
	await expect(page.getByLabel('Bond in your own words')).toHaveValue('drinking buddies');
	await expect(page.getByText(/charge this Bond/i)).toHaveCount(0);
});
