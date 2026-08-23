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

	// The status panel saves on a debounce and resyncs `char` from the server
	// after every PUT. Each wait is registered BEFORE the change that schedules
	// its save (a listener added later can miss a fast PUT) and matches on the
	// request payload, so an earlier field's save is never mistaken for the one
	// under test. Each group awaits its save before the next change so the
	// post-save resync has nothing of ours to clobber.
	const savedWith = (match: (bond: { text: string }) => boolean) =>
		page.waitForResponse((res) => {
			if (!res.url().includes(`/api/characters/${id}`)) return false;
			if (res.request().method() !== 'PUT' || !res.ok()) return false;
			const body = res.request().postDataJSON() as {
				character: { bonds: { text: string }[] };
			};
			return body.character.bonds.some(match);
		});

	await page.getByPlaceholder("Guild-mate's name").fill('Grendel');
	await page.getByRole('button', { name: 'Add bond' }).click();

	const bondType = page.getByLabel('Bond type');
	await expect(bondType).toHaveValue('');

	let pending = savedWith((b) => b.text === 'Rival');
	await bondType.selectOption('Rival');
	await expect(page.getByText('Charge this Bond when you witness your rival succeed on a test of fate.')).toBeVisible();
	await pending;

	// A two-sided Bond quotes both halves, not just the first.
	pending = savedWith((b) => b.text === 'Mentor/Mentee');
	await bondType.selectOption('Mentor/Mentee');
	await expect(page.getByText('Mentees charge this Bond when they ask the mentor for advice and it is given.')).toBeVisible();
	await expect(page.getByText('Mentors charge this Bond when a mentee follows their advice.')).toBeVisible();

	// The choice and its charge lines survive a reload.
	await pending;
	await page.reload();
	await expect(page.getByLabel('Bond type')).toHaveValue('Mentor/Mentee');
	await expect(page.getByText('Mentors charge this Bond when a mentee follows their advice.')).toBeVisible();

	// A bond in the player's own words keeps its text and offers no charge line.
	pending = savedWith((b) => b.text === 'drinking buddies');
	await page.getByLabel('Bond type').selectOption({ label: 'Something else…' });
	await page.getByLabel('Bond in your own words').fill('drinking buddies');
	await pending;
	await page.reload();
	await expect(page.getByLabel('Bond in your own words')).toHaveValue('drinking buddies');
	await expect(page.getByText(/charge this Bond/i)).toHaveCount(0);

	// Landing on the placeholder never destroys the player's own words: the
	// text stays, and the select snaps back to custom mode.
	await page.getByLabel('Bond type').selectOption({ label: 'Bond type…' });
	await expect(page.getByLabel('Bond in your own words')).toHaveValue('drinking buddies');
	await expect(page.getByLabel('Bond type')).toHaveValue('__custom__');
});
