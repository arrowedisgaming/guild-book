import type { GuildBookCharacterData } from '../../src/lib/types/character';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { signInAs, createTestAdventurer } from './fixtures/auth';

// The Experience section is collapsed by default; only its summary (heading
// and available XP) is visible until it is opened.
// A fixed-amount award is one button; the reason is optional.
const award = (xp: Locator) => xp.getByRole('button', { name: /^Quest accepted/ });
const openHistory = (xp: Locator) => xp.getByText(/^XP history/).click();

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
 await xp.getByLabel('Reason').fill('Rescue the bellringer');
 await award(xp).click();
 await expect(xp.getByText('Available XP: 3', { exact: true })).toBeVisible();
 await openHistory(xp);
 await expect(xp.getByText('Rescue the bellringer', { exact: true })).toBeVisible();
 await page.reload();
 await expect(xp.getByText('Available XP: 3', { exact: true })).toBeVisible();
 await openExperience(page);
 await openHistory(xp);
 await expect(xp.getByText('Rescue the bellringer', { exact: true })).toBeVisible();
});

test('an award is one tap, and a reason is optional', async ({ page }) => {
 await signInAs(page, 'Quick XP');
 const { id } = await createTestAdventurer(page, 'Hasty Recorder');
 await page.goto(`/sheet/${id}`);
 const xp = await openExperience(page);
 await xp.getByRole('button', { name: /^Contract completed/ }).click();
 await expect(xp.getByText('Available XP: 1', { exact: true })).toBeVisible();
 await openHistory(xp);
 await expect(xp.getByText('+1 XP, Contract completed', { exact: true })).toBeVisible();
 // Spending still has to say what it was for.
 await xp.getByText('Spend XP, a custom award or a correction').click();
 await expect(xp.getByRole('button', { name: 'Record XP' })).toBeDisabled();
 await xp.getByLabel('Reason').fill('Bribed the gatekeeper');
 await xp.getByRole('button', { name: 'Record XP' }).click();
 await expect(xp.getByText('Available XP: 0', { exact: true })).toBeVisible();
 await page.reload();
 await expect(xp.getByText('Available XP: 0', { exact: true })).toBeVisible();
});

test('the seventh invested XP masters a talent and saves itself', async ({ page }) => {
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
 const acrobat = page.locator('.talents-edit .row', { hasText: 'Acrobat' });
 // Closed, the row already says where the talent stands; its controls open with it.
 await expect(acrobat.locator('summary').first()).toContainText('In training, 6 of 7 XP');
 await acrobat.locator('summary').first().click();
 await acrobat.getByText('Adjust without spending XP').click();
 await expect(acrobat.locator('.xp')).toContainText('XP 6/7');
 await acrobat.getByRole('button', { name: 'Add XP' }).click();
 await expect(acrobat.getByRole('button', { name: 'mastered' })).toBeVisible();
 await expect(acrobat.getByRole('button', { name: 'Add XP' })).toHaveCount(0);
 // No Save button: the change stores itself and the sheet says so.
 await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
 await expect(page.locator('.save-state')).toHaveText('Saved');
 await page.reload();
 await expect(acrobat.locator('summary').first()).toContainText('Mastered');
});

test('using a talent in training spends XP and writes the history in one step', async ({ page }) => {
 await signInAs(page, 'Talent User');
 const { id } = await createTestAdventurer(page, 'Nimble Student');
 await page.goto(`/sheet/${id}`);
 const talents = page.locator('.talents-edit');
 // Fuzzy: a few letters are enough to find it.
 await talents.getByLabel('Add a talent').fill('acrob');
 await expect(talents.getByRole('option').first()).toContainText('Acrobat');
 await talents.getByLabel('Add a talent').press('Enter');
 const acrobat = talents.locator('.row', { hasText: 'Acrobat' });
 await acrobat.locator('summary').first().click();
 // Nothing to spend yet.
 await expect(acrobat.getByRole('button', { name: 'Use for 1 XP' })).toBeDisabled();
 const xp = await openExperience(page);
 await award(xp).click();
 await expect(xp.getByText('Available XP: 3', { exact: true })).toBeVisible();
 await acrobat.getByRole('button', { name: 'Use for 1 XP' }).click();
 await expect(acrobat.locator('summary').first()).toContainText('In training, 1 of 7 XP');
 await expect(xp.getByText('Available XP: 2', { exact: true })).toBeVisible();
 await openHistory(xp);
 await expect(xp.getByText('-1 XP, Acrobat', { exact: true })).toBeVisible();
 await page.reload();
 await expect(acrobat.locator('summary').first()).toContainText('In training, 1 of 7 XP');
 await expect(xp.getByText('Available XP: 2', { exact: true })).toBeVisible();
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
 await award(xp).click();
 await expect(page.getByRole('alert')).toContainText('Temporary rejection');
 await expect(xp.getByText('Available XP: 0', { exact: true })).toBeVisible();
 await page.unroute(`**/api/characters/${id}`);
 await award(xp).click();
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
 await award(xp).click();
 await expect(page.getByRole('button', { name: 'Retry reload' })).toBeVisible();
 await expect(award(xp)).toBeDisabled();
 await page.unroute(`**/api/characters/${id}`);
 await page.getByRole('button', { name: 'Retry reload' }).click();
 await expect(xp.getByText('Available XP: 0', { exact: true })).toBeVisible();
 await award(xp).click();
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
 await award(xp).click();
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
 await award(xp).click();
 await expect(xp.getByText('Available XP: 3', { exact: true })).toBeVisible();
 await expect(xp.getByLabel('Reason')).toHaveValue('');
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
 await xp.getByLabel('Reason').fill('Recorded before finalizing');
 const finalizeButton = page.getByRole('button', { name: 'Finalize', exact: true });
 const recording = award(xp).click();
 await expect(finalizeButton).toBeDisabled();
 await expect(page.locator('.save-state')).toHaveText('Saving…');
 releasePut();
 await recording;
 await expect(xp.getByText('Available XP: 3', { exact: true })).toBeVisible();
 await expect(finalizeButton).toBeEnabled();
 await expect(page.locator('.save-state')).toHaveText('Saved');
});
