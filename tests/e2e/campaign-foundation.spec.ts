import { expect, test, type Page } from '@playwright/test';
import {
	archiveTestAdventurer,
	createTestAdventurer,
	markTestAdventurerDead,
	signInAs
} from './fixtures/auth';

test.describe('campaign foundation', () => {
	test('GM creates a campaign and a player joins then attaches one adventurer', async ({ browser }) => {
		const gm = await browser.newContext();
		const player = await browser.newContext();
		const gmPage = await gm.newPage();
		const playerPage = await player.newPage();
		await signInAs(gmPage, 'Guild Master');
		await signInAs(playerPage, 'Player');
		await createTestAdventurer(playerPage, 'Mara Vey');

		const invite = await createCampaignAndReadInvite(gmPage, 'Undercrypt');
		await playerPage.goto(invite);
		await expect(playerPage.getByRole('heading', { name: 'Join Undercrypt' })).toBeVisible();
		await playerPage.getByRole('button', { name: 'Join campaign' }).click();
		await expect(playerPage.getByText('Joined without an adventurer')).toBeVisible();
		await playerPage.getByRole('button', { name: 'Attach adventurer' }).click();
		await expect(playerPage.getByText('1 active adventurer')).toBeVisible();

		await gm.close();
		await player.close();
	});

	test('closed and rotated invitations invalidate the exposed link', async ({ browser }) => {
		const gm = await browser.newContext();
		const player = await browser.newContext();
		const gmPage = await gm.newPage();
		const playerPage = await player.newPage();
		await signInAs(gmPage, 'Invite Keeper');
		await signInAs(playerPage, 'Invite Guest');

		const oldInvite = await createCampaignAndReadInvite(gmPage, 'Rotating Door');
		const visitor = await browser.newContext();
		const redirect = await visitor.request.get(oldInvite, { maxRedirects: 0 });
		expect(redirect.status()).toBe(302);
		expect(redirect.headers()['cache-control']).toContain('private');
		expect(redirect.headers()['cache-control']).toContain('no-store');
		await visitor.close();
		await gmPage.getByRole('button', { name: 'Close invitation' }).click();
		const closedResponse = await playerPage.goto(oldInvite);
		expect(closedResponse?.status()).toBe(404);
		await expect(playerPage.getByText('This invitation is no longer available.')).toBeVisible();

		gmPage.once('dialog', (dialog) => dialog.accept());
		await gmPage.getByRole('button', { name: 'Rotate invitation' }).click();
		const newInvite = await gmPage.getByLabel('Invite link').inputValue();
		expect(newInvite).not.toBe(oldInvite);
		const rotatedResponse = await playerPage.goto(oldInvite);
		expect(rotatedResponse?.status()).toBe(404);
		await expect(playerPage.getByText('This invitation is no longer available.')).toBeVisible();
		await playerPage.goto(newInvite);
		await expect(playerPage.getByRole('button', { name: 'Join campaign' })).toBeVisible();

		await gm.close();
		await player.close();
	});

	test('archived campaigns remain visible but read-only to current participants', async ({ browser }) => {
		const gm = await browser.newContext();
		const player = await browser.newContext();
		const gmPage = await gm.newPage();
		const playerPage = await player.newPage();
		await signInAs(gmPage, 'Archive GM');
		await signInAs(playerPage, 'Archive Player');
		const invite = await createCampaignAndReadInvite(gmPage, 'Last Chronicle');
		await joinCampaign(playerPage, invite);

		gmPage.once('dialog', (dialog) => dialog.accept());
		await gmPage.getByRole('button', { name: 'Archive campaign' }).click();
		await expect(gmPage.getByRole('link', { name: /Last Chronicle/ })).toBeVisible();
		await gmPage.getByRole('link', { name: /Last Chronicle/ }).click();
		await expect(gmPage.getByText('Archived — read-only')).toBeVisible();
		await expect(gmPage.getByRole('heading', { name: 'Invitation controls' })).toHaveCount(0);
		await playerPage.reload();
		await expect(playerPage.getByText('Archived — read-only')).toBeVisible();
		await expect(playerPage.getByRole('button', { name: 'Leave campaign' })).toHaveCount(0);

		await gm.close();
		await player.close();
	});

	test('players never receive GM controls', async ({ browser }) => {
		const gm = await browser.newContext();
		const player = await browser.newContext();
		const gmPage = await gm.newPage();
		const playerPage = await player.newPage();
		await signInAs(gmPage, 'Hidden Controls GM');
		await signInAs(playerPage, 'Hidden Controls Player');
		const invite = await createCampaignAndReadInvite(gmPage, 'Veiled Hall');
		await joinCampaign(playerPage, invite);

		await expect(playerPage.getByRole('heading', { name: 'Invitation controls' })).toHaveCount(0);
		await expect(playerPage.getByRole('button', { name: 'Archive campaign' })).toHaveCount(0);
		await expect(playerPage.getByRole('button', { name: 'Remove member' })).toHaveCount(0);

		await gm.close();
		await player.close();
	});

	test('adventurer picker excludes draft, dead, archived, and attached characters', async ({ browser }) => {
		const gm = await browser.newContext();
		const player = await browser.newContext();
		const gmPage = await gm.newPage();
		const playerPage = await player.newPage();
		await signInAs(gmPage, 'Picker GM');
		await signInAs(playerPage, 'Picker Player');
		await createTestAdventurer(playerPage, 'Eligible Hero');
		await createTestAdventurer(playerPage, 'Draft Hero', { draft: true });
		const dead = await createTestAdventurer(playerPage, 'Dead Hero');
		await markTestAdventurerDead(playerPage, dead);
		const archived = await createTestAdventurer(playerPage, 'Archived Hero');
		await archiveTestAdventurer(playerPage, archived.id);

		const invite = await createCampaignAndReadInvite(gmPage, 'Picker Hall');
		await joinCampaign(playerPage, invite);
		const picker = playerPage.getByLabel('Adventurer', { exact: true });
		await expect(picker.getByRole('option', { name: 'Eligible Hero' })).toHaveCount(1);
		await expect(picker.getByRole('option', { name: 'Draft Hero' })).toHaveCount(0);
		await expect(picker.getByRole('option', { name: 'Dead Hero' })).toHaveCount(0);
		await expect(picker.getByRole('option', { name: 'Archived Hero' })).toHaveCount(0);
		await playerPage.getByRole('button', { name: 'Attach adventurer' }).click();
		await expect(playerPage.getByLabel('Adventurer', { exact: true })).toHaveCount(0);

		await gm.close();
		await player.close();
	});

	test('players can voluntarily replace an adventurer outside a session', async ({ browser }) => {
		const gm = await browser.newContext();
		const player = await browser.newContext();
		const gmPage = await gm.newPage();
		const playerPage = await player.newPage();
		await signInAs(gmPage, 'Replacement GM');
		await signInAs(playerPage, 'Replacement Player');
		await createTestAdventurer(playerPage, 'First Hero');
		await createTestAdventurer(playerPage, 'Second Hero');
		const invite = await createCampaignAndReadInvite(gmPage, 'Changing Guard');
		await joinCampaign(playerPage, invite);

		await playerPage.getByLabel('Adventurer', { exact: true }).selectOption({ label: 'First Hero' });
		await playerPage.getByRole('button', { name: 'Attach adventurer' }).click();
		await playerPage.getByLabel('Adventurer', { exact: true }).selectOption({ label: 'Second Hero' });
		playerPage.once('dialog', (dialog) => dialog.accept());
		await playerPage.getByRole('button', { name: 'Replace adventurer' }).click();
		await expect(playerPage.getByText('Second Hero', { exact: true })).toBeVisible();
		await expect(playerPage.getByText('First Hero — replaced')).toBeVisible();
		await expect(playerPage.getByText('1 active adventurer')).toBeVisible();

		await gm.close();
		await player.close();
	});

	test('campaign pages are always private and non-cacheable', async ({ page }) => {
		await signInAs(page, 'Cache Tester');
		const response = await page.goto('/campaigns');
		expect(response?.headers()['cache-control']).toContain('private');
		expect(response?.headers()['cache-control']).toContain('no-store');
	});
});

async function createCampaignAndReadInvite(page: Page, name: string): Promise<string> {
	await page.goto('/campaigns/new');
	await page.getByLabel('Campaign name').fill(name);
	await page.getByRole('button', { name: 'Create campaign' }).click();
	await page.waitForURL(/\/campaigns\/[^/]+$/);
	return page.getByLabel('Invite link').inputValue();
}

async function joinCampaign(page: Page, invite: string): Promise<void> {
	await page.goto(invite);
	await page.getByRole('button', { name: 'Join campaign' }).click();
	await expect(page.getByText('Joined without an adventurer')).toBeVisible();
}
