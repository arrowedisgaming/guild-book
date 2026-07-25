import { expect, test, type Locator, type Page } from '@playwright/test';
import { signInAs, createTestAdventurer } from './fixtures/auth';
import { attachAdventurer, campaignIdFromUrl, createCampaignAndReadInvite, joinCampaign } from './fixtures/challenge';

/**
 * Increment 4 Task 6 — departure and the archive boundary, end to end.
 *
 * What only a browser proves: a player who leaves mid-session loses the table
 * on their next request (a real 404, not a blanked component), the GM's view
 * heals (the departed hand count disappears), and the archive action is
 * refused while the session is open and succeeds after it ends.
 */

async function clickGeneric(page: Page, locator: Locator, timeoutMs = 8000): Promise<void> {
	const [response] = await Promise.all([
		page.waitForResponse(
			(res) => res.url().includes('/commands') && !res.url().match(/(challenge|guided-test|camp|finite|correction)-commands/),
			{ timeout: timeoutMs }
		),
		locator.click()
	]);
	if (!response.ok()) throw new Error(`generic command failed (HTTP ${response.status()})`);
}

test('leaving mid-session revokes access, heals the table, and archiving respects the open-session boundary', async ({ browser }) => {
	test.setTimeout(180_000);

	const gm = await browser.newContext();
	const playerA = await browser.newContext();
	const gmPage = await gm.newPage();
	const playerAPage = await playerA.newPage();

	await signInAs(gmPage, 'Departure GM');
	await signInAs(playerAPage, 'Departure Player A');
	await createTestAdventurer(playerAPage, 'Wanderer Sel');

	const invite = await createCampaignAndReadInvite(gmPage, 'Departure Table');
	const campaignId = campaignIdFromUrl(gmPage.url());
	await joinCampaign(playerAPage, invite);
	await attachAdventurer(playerAPage, 'Wanderer Sel');

	await gmPage.goto(`/campaigns/${campaignId}/table`);
	await gmPage.getByRole('button', { name: 'Start session' }).click();
	await expect(gmPage.getByRole('button', { name: 'Draw a card' })).toBeVisible();

	await playerAPage.goto(`/campaigns/${campaignId}/table`);
	await expect(playerAPage.getByRole('button', { name: 'Draw a card' })).toBeVisible({ timeout: 4000 });

	// Player A holds two private cards the cleanup must sweep.
	await clickGeneric(playerAPage, playerAPage.getByRole('button', { name: 'Draw a card' }));
	await clickGeneric(playerAPage, playerAPage.getByRole('button', { name: 'Draw a card' }));

	// The GM sees A's hand count before the departure.
	await expect(gmPage.getByText(/2 cards?/).first()).toBeVisible({ timeout: 6000 });

	// --- The archive boundary holds while the session is open ---
	await gmPage.goto(`/campaigns/${campaignId}`);
	gmPage.once('dialog', (dialog) => void dialog.accept());
	await gmPage.getByRole('button', { name: 'Archive campaign' }).click();
	await expect(gmPage.getByText('End the open session before archiving the campaign.')).toBeVisible({ timeout: 6000 });

	// --- Player A leaves mid-session ---
	await playerAPage.goto(`/campaigns/${campaignId}`);
	playerAPage.once('dialog', (dialog) => void dialog.accept());
	await playerAPage.getByRole('button', { name: 'Leave campaign' }).click();
	await expect(playerAPage).toHaveURL(/\/campaigns$/, { timeout: 8000 });

	// Their next table request is a genuine 404.
	const tableResponse = await playerAPage.goto(`/campaigns/${campaignId}/table`);
	expect(tableResponse?.status()).toBe(404);

	// The GM's table heals: the departed hand count is gone and the table is
	// still fully usable.
	await gmPage.goto(`/campaigns/${campaignId}/table`);
	await expect(gmPage.getByRole('button', { name: 'Draw a card' })).toBeVisible({ timeout: 6000 });
	await expect(gmPage.getByText(/2 cards?/)).toHaveCount(0);
	await clickGeneric(gmPage, gmPage.getByRole('button', { name: 'Draw a card' }));

	// --- End the session; the archive boundary opens ---
	await gmPage.getByRole('button', { name: 'End session', exact: true }).click();
	await gmPage.getByRole('button', { name: 'Confirm end' }).click();
	await expect(gmPage.getByRole('button', { name: 'Start session' })).toBeVisible({ timeout: 8000 });

	await gmPage.goto(`/campaigns/${campaignId}`);
	gmPage.once('dialog', (dialog) => void dialog.accept());
	await gmPage.getByRole('button', { name: 'Archive campaign' }).click();
	await expect(gmPage).toHaveURL(/\/campaigns$/, { timeout: 8000 });

	await gm.close();
	await playerA.close();
});
