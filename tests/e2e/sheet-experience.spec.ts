import type { GuildBookCharacterData } from '../../src/lib/types/character';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { signInAs, createTestAdventurer } from './fixtures/auth';

// The Experience section is collapsed by default; only its summary (heading
// and available XP) is visible until it is opened.
async function openExperience(page: Page): Promise<Locator> {
 const xp = page.getByRole('region', { name: 'Experience' });
 await xp.locator('summary').first().click();
 return xp;
}

test('XP awards explain the balance and survive reload', async ({ page }) => {
 await signInAs(page, 'Experience');
 const { id } = await createTestAdventurer(page, 'Scholar of Experience');
 await page.goto(`/sheet/${id}`);
 let xp = page.getByRole('region', { name: 'Experience' });
 await expect(xp.getByText('Available XP: 0', { exact: true })).toBeVisible();
 xp = await openExperience(page);
 await xp.getByLabel('XP source').selectOption('quest-accepted');
 await xp.getByLabel('Reason').fill('Rescue the bellringer');
 await xp.getByRole('button', { name: 'Record XP' }).click();
 await expect(xp.getByText('Available XP: 3', { exact: true })).toBeVisible();
 await expect(xp.getByText('Rescue the bellringer', { exact: true })).toBeVisible();
 await page.reload();
 await expect(xp.getByText('Available XP: 3', { exact: true })).toBeVisible();
 await openExperience(page);
 await expect(xp.getByText('Rescue the bellringer', { exact: true })).toBeVisible();
});

test('the seventh invested XP masters a talent on the edit sheet', async ({ page }) => {
 await signInAs(page, 'Training');
 const { id } = await createTestAdventurer(page, 'Patient Acrobat');
 // Talent progress is marked directly on the sheet, so seeding it is one save.
 await page.evaluate(async id => {
  const row = (await (await fetch(`/api/characters/${id}`)).json()) as { data: GuildBookCharacterData; version: number };
  row.data.talents = [{ talentId: 'acrobat', state: 'in-training', source: 'general', sourceLabel: 'Test training', at: new Date().toISOString(), wounded: false, xp: 6, preparedUses: 0 }];
  const response = await fetch(`/api/characters/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ character: row.data, expectedVersion: row.version }) });
  if (!response.ok) throw new Error(await response.text());
 }, id);
 await page.goto(`/sheet/${id}`);
 await page.getByRole('button', { name: 'Edit' }).click();
 const acrobat = page.locator('.talents-edit .row', { hasText: 'Acrobat' });
 await expect(acrobat.locator('.xp')).toContainText('XP 6/7');
 await acrobat.getByRole('button', { name: 'Add XP' }).click();
 await expect(acrobat.getByRole('button', { name: 'mastered' })).toBeVisible();
 await expect(acrobat.getByRole('button', { name: 'Add XP' })).toHaveCount(0);
 await page.getByRole('button', { name: 'Save changes' }).click();
 await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible();
 await page.reload();
 await page.getByRole('button', { name: 'Edit' }).click();
 await expect(acrobat.getByRole('button', { name: 'mastered' })).toBeVisible();
});

test('retrying a rejected award does not record it twice', async ({ page }) => {
 await signInAs(page, 'Retry XP');
 const { id } = await createTestAdventurer(page, 'Careful Recorder');
 await page.goto(`/sheet/${id}`);
 const xp = await openExperience(page);
 await xp.getByLabel('Reason').fill('Rescue the bellringer');
 await page.route(`**/api/characters/${id}`, async route => {
  if (route.request().method() === 'PUT') { await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'Temporary rejection' }) }); }
  else await route.continue();
 });
 await xp.getByRole('button', { name: 'Record XP' }).click();
 await expect(page.getByRole('alert')).toContainText('Temporary rejection');
 await expect(xp.getByText('Available XP: 0', { exact: true })).toBeVisible();
 await page.unroute(`**/api/characters/${id}`);
 await xp.getByRole('button', { name: 'Record XP' }).click();
 await expect(xp.getByText('Available XP: 3', { exact: true })).toBeVisible();
 await page.reload();
 await expect(xp.getByText('Available XP: 3', { exact: true })).toBeVisible();
 await expect(xp.getByText('Rescue the bellringer', { exact: true })).toHaveCount(1);
});

test('an unconfirmed save blocks new awards until the character reloads', async ({ page }) => {
 await signInAs(page, 'Offline XP');
 const { id } = await createTestAdventurer(page, 'Offline Recorder');
 await page.goto(`/sheet/${id}`);
 const xp = await openExperience(page);
 await xp.getByLabel('Reason').fill('Rescue the bellringer');
 await page.route(`**/api/characters/${id}`, route => route.abort());
 await xp.getByRole('button', { name: 'Record XP' }).click();
 await expect(page.getByRole('button', { name: 'Retry reload' })).toBeVisible();
 await expect(xp.getByRole('button', { name: 'Record XP' })).toBeDisabled();
 await page.unroute(`**/api/characters/${id}`);
 await page.getByRole('button', { name: 'Retry reload' }).click();
 await expect(xp.getByText('Available XP: 0', { exact: true })).toBeVisible();
 await xp.getByRole('button', { name: 'Record XP' }).click();
 await expect(xp.getByText('Available XP: 3', { exact: true })).toBeVisible();
});

test('a pending status edit and an XP award both survive', async ({ page }) => {
 await signInAs(page, 'Combined XP');
 const { id } = await createTestAdventurer(page, 'Bonded Recorder');
 await page.goto(`/sheet/${id}`);
 const xp = await openExperience(page);
 await xp.getByLabel('Reason').fill('Accepted the bell quest');
 await page.getByPlaceholder("Guild-mate's name").fill('Grendel');
 await page.getByRole('button', { name: 'Add bond' }).click();
 await xp.getByRole('button', { name: 'Record XP' }).click();
 await expect(xp.getByText('Available XP: 3', { exact: true })).toBeVisible();
 await page.reload();
 await expect(xp.getByText('Available XP: 3', { exact: true })).toBeVisible();
 await expect(page.getByLabel("Guild-mate's name")).toHaveValue('Grendel');
});

test('a committed award with a lost response is recognized by its entry ID', async ({ page }) => {
 await signInAs(page, 'Lost Response XP');
 const { id } = await createTestAdventurer(page, 'Confirmed Recorder');
 await page.goto(`/sheet/${id}`);
 const xp = await openExperience(page);
 await xp.getByLabel('Reason').fill('Rescue the bellringer');
 await page.route(`**/api/characters/${id}`, async route => {
  if (route.request().method() === 'PUT') { await route.fetch(); await route.abort(); }
  else await route.continue();
 });
 await xp.getByRole('button', { name: 'Record XP' }).click();
 await expect(xp.getByText('Available XP: 3', { exact: true })).toBeVisible();
 await expect(xp.getByLabel('Reason')).toHaveValue('');
 await expect(xp.getByRole('button', { name: 'Record XP' })).toBeDisabled();
 await page.reload();
 await expect(xp.getByText('Rescue the bellringer', { exact: true })).toHaveCount(1);
});

test('finalizing a draft is blocked while an XP action is being recorded', async ({ page }) => {
 await signInAs(page, 'Finalizer');
 const { id } = await createTestAdventurer(page, 'Draft Adventurer', { draft: true });
 await page.goto(`/sheet/${id}`);
 // Hold the PUT open on an explicit gate — not a timer — so there is no race
 // between the artificial delay and how long the assertion below takes to
 // observe the disabled state.
 let releasePut = () => {};
 const putHeld = new Promise<void>((resolve) => { releasePut = resolve; });
 await page.route(`**/api/characters/${id}`, async route => {
  if (route.request().method() === 'PUT') await putHeld;
  await route.continue();
 });
 const xp = await openExperience(page);
 await xp.getByLabel('XP source').selectOption('quest-accepted');
 await xp.getByLabel('Reason').fill('Recorded before finalizing');
 // The button's own label switches to "Saving…" once the fieldset locks it
 // (matching "Save changes" elsewhere on this page), so it's found by class.
 const finalizeButton = page.locator('button.finalize');
 const recording = xp.getByRole('button', { name: 'Record XP' }).click();
 await expect(finalizeButton).toBeDisabled();
 await expect(finalizeButton).toHaveText('Saving…');
 releasePut();
 await recording;
 await expect(xp.getByText('Available XP: 3', { exact: true })).toBeVisible();
 await expect(finalizeButton).toBeEnabled();
 await expect(finalizeButton).toHaveText('Save as final');
});
