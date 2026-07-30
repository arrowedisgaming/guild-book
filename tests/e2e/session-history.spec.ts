import { expect, test, type Locator, type Page } from '@playwright/test';
import { signInAs, createTestAdventurer } from './fixtures/auth';
import { attachAdventurer, campaignIdFromUrl, createCampaignAndReadInvite, joinCampaign } from './fixtures/challenge';

/**
 * Increment 4 Task 5 — corrections and completed history end to end.
 *
 * What only a browser proves: the correction is applied from the GM's own
 * rendered dialog and lands in the public log; the completed history page
 * renders for a current member and 404s for an outsider; and the ordered log
 * (including the correction, with its reason) survives into history.
 */

async function clickGeneric(page: Page, locator: Locator, timeoutMs = 15000): Promise<void> {
	const [response] = await Promise.all([
		page.waitForResponse(
			(res) => res.url().includes('/commands') && !res.url().match(/(challenge|guided-test|camp|finite|correction)-commands/),
			{ timeout: timeoutMs }
		),
		locator.click()
	]);
	if (!response.ok()) throw new Error(`generic command failed (HTTP ${response.status()})`);
}

test('a GM correction is audited and completed history is member-gated', async ({ browser }) => {
	test.setTimeout(180_000);

	const gm = await browser.newContext();
	const playerA = await browser.newContext();
	const outsider = await browser.newContext();
	const gmPage = await gm.newPage();
	const playerAPage = await playerA.newPage();
	const outsiderPage = await outsider.newPage();

	await signInAs(gmPage, 'History GM');
	await signInAs(playerAPage, 'History Player A');
	await signInAs(outsiderPage, 'History Outsider');
	await createTestAdventurer(playerAPage, 'Archivist Bren');

	const invite = await createCampaignAndReadInvite(gmPage, 'History Table');
	const campaignId = campaignIdFromUrl(gmPage.url());
	await joinCampaign(playerAPage, invite);
	await attachAdventurer(playerAPage, 'Archivist Bren');

	await gmPage.goto(`/campaigns/${campaignId}/table`);
	await gmPage.getByRole('button', { name: 'Start session' }).click();
	await expect(gmPage.getByRole('button', { name: 'Draw a card' })).toBeVisible();
	await playerAPage.goto(`/campaigns/${campaignId}/table`);
	await expect(playerAPage.getByRole('button', { name: 'Draw a card' })).toBeVisible({ timeout: 4000 });

	// The GM draws a Doom and plays it publicly — the card the correction moves.
	await clickGeneric(gmPage, gmPage.getByRole('button', { name: 'Draw a card' }));
	const playButton = gmPage.getByRole('button', { name: /^Play/ }).first();
	await expect(playButton).toBeVisible({ timeout: 4000 });
	await clickGeneric(gmPage, playButton);

	// --- The correction dialog is the GM's alone ---
	await expect(playerAPage.getByTestId('open-correction')).toHaveCount(0);
	const openCorrection = gmPage.getByTestId('open-correction').first();
	await expect(openCorrection).toBeVisible({ timeout: 4000 });
	await openCorrection.click();

	const dialog = gmPage.getByTestId('correction-dialog').first();
	await expect(dialog).toBeVisible();
	// Compensate for the most recent event: move the played card to the major
	// discard with a stated reason.
	const target = dialog.getByTestId('correction-target');
	await target.selectOption({ index: 1 });
	await dialog.getByTestId('correction-source').selectOption('played');
	await dialog.getByTestId('correction-card').selectOption({ index: 1 });
	await dialog.getByTestId('correction-destination').selectOption('majorDiscard');
	await dialog.getByTestId('correction-reason').fill('played by mistake — returning it');

	const [response] = await Promise.all([
		gmPage.waitForResponse((res) => res.url().includes('/correction-commands'), { timeout: 15000 }),
		dialog.getByTestId('submit-correction').click()
	]);
	expect(response.ok()).toBe(true);

	// --- End the session and read history as a member ---
	await gmPage.getByRole('button', { name: 'End session', exact: true }).click();
	await expect(gmPage.getByTestId('end-session-confirm')).toBeVisible();
	await gmPage.getByRole('button', { name: 'Confirm end' }).click();
	await expect(gmPage.getByRole('button', { name: 'Start session' })).toBeVisible({ timeout: 15000 });

	await playerAPage.goto(`/campaigns/${campaignId}/sessions`);
	await expect(playerAPage.getByTestId('session-list')).toBeVisible({ timeout: 4000 });
	await playerAPage.getByTestId('session-link-1').click();
	await expect(playerAPage.getByTestId('history-log')).toBeVisible({ timeout: 4000 });
	await expect(playerAPage.getByTestId('history-log')).toContainText('played by mistake — returning it');
	await expect(playerAPage.getByTestId('history-meta')).toContainText('checksum');

	// --- An outsider gets 404s, not history ---
	const listResponse = await outsiderPage.goto(`/campaigns/${campaignId}/sessions`);
	expect(listResponse?.status()).toBe(404);

	await gm.close();
	await playerA.close();
	await outsider.close();
});
