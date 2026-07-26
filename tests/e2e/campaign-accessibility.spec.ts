import { expect, test, type Locator, type Page } from '@playwright/test';
import { signInAs, createTestAdventurer } from './fixtures/auth';
import { attachAdventurer, campaignIdFromUrl, createCampaignAndReadInvite, joinCampaign } from './fixtures/challenge';

/**
 * Increment 4 Task 7 Step 1 — release-candidate accessibility assertions,
 * implemented as Playwright role/name checks (@axe-core/playwright was not
 * approved as a dev dependency; the project's chosen external audit runs in
 * CI per the plan).
 *
 * The privacy-adjacent assertions are the sharpest: a card back's accessible
 * name is exactly "Face-down card" and the hidden identity appears NOWHERE in
 * the other player's DOM — not aria-label, not title, not a data attribute,
 * not offscreen text.
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

test('keyboard operation, labelled controls, live announcements, and no identity behind a card back', async ({ browser }) => {
	test.setTimeout(180_000);

	const gm = await browser.newContext();
	const playerA = await browser.newContext();
	const playerB = await browser.newContext();
	const gmPage = await gm.newPage();
	const playerAPage = await playerA.newPage();
	const playerBPage = await playerB.newPage();

	await signInAs(gmPage, 'A11y GM');
	await signInAs(playerAPage, 'A11y Player A');
	await signInAs(playerBPage, 'A11y Player B');
	await createTestAdventurer(playerAPage, 'Quiet Reeve');
	await createTestAdventurer(playerBPage, 'Loud Marsh');

	const invite = await createCampaignAndReadInvite(gmPage, 'A11y Table');
	const campaignId = campaignIdFromUrl(gmPage.url());
	await joinCampaign(playerAPage, invite);
	await attachAdventurer(playerAPage, 'Quiet Reeve');
	await joinCampaign(playerBPage, invite);
	await attachAdventurer(playerBPage, 'Loud Marsh');

	await gmPage.goto(`/campaigns/${campaignId}/table`);
	await gmPage.getByRole('button', { name: 'Start session' }).click();
	await expect(gmPage.getByRole('button', { name: 'Draw a card' })).toBeVisible();
	await playerAPage.goto(`/campaigns/${campaignId}/table`);
	await playerBPage.goto(`/campaigns/${campaignId}/table`);
	await expect(playerAPage.getByRole('button', { name: 'Draw a card' })).toBeVisible({ timeout: 4000 });
	await expect(playerBPage.getByRole('button', { name: 'Draw a card' })).toBeVisible({ timeout: 4000 });

	// --- Keyboard-only: focus the draw control and activate it with Enter ---
	await playerAPage.getByRole('button', { name: 'Draw a card' }).focus();
	await expect(playerAPage.getByRole('button', { name: 'Draw a card' })).toBeFocused();
	const [drawResponse] = await Promise.all([
		playerAPage.waitForResponse((res) => res.url().includes('/commands') && res.request().method() === 'POST', { timeout: 8000 }),
		playerAPage.keyboard.press('Enter')
	]);
	expect(drawResponse.ok()).toBe(true);

	// --- The drawn card's controls are BUTTONS whose names carry the card ---
	const handCard = playerAPage.getByTestId('hand-card').first();
	await expect(handCard).toBeVisible({ timeout: 4000 });
	const groupLabel = await handCard.getAttribute('aria-label');
	expect(groupLabel).toMatch(/^Card 1 of 1: .+/);
	const cardName = groupLabel!.replace('Card 1 of 1: ', '');
	expect(cardName.length).toBeGreaterThan(0);
	await expect(playerAPage.getByRole('button', { name: `Play ${cardName}`, exact: true })).toBeVisible();
	await expect(playerAPage.getByRole('button', { name: `Discard ${cardName}`, exact: true })).toBeVisible();

	// --- Face-down/prepared privacy: play it face down, then check B's DOM ---
	await clickGeneric(playerAPage, playerAPage.getByRole('button', { name: `Play ${cardName} face down`, exact: true }));

	// Player B sees THAT a card is face down; the identity string appears
	// nowhere in their whole rendered document.
	await expect(playerBPage.getByText(/Face-down \(1\)/).first()).toBeVisible({ timeout: 6000 });
	const backs = playerBPage.getByRole('img', { name: 'Face-down card' });
	await expect(backs.first()).toBeVisible();
	const bDocument = await playerBPage.content();
	expect(bDocument).not.toContain(cardName);
	// And the same holds for the GM.
	const gmDocument = await gmPage.content();
	expect(gmDocument).not.toContain(cardName);

	// --- Focus retention across the ~1s polling cycle ---
	await playerBPage.getByRole('button', { name: 'Draw a card' }).focus();
	await playerBPage.waitForTimeout(2600); // two-plus poll cycles
	await expect(playerBPage.getByRole('button', { name: 'Draw a card' })).toBeFocused();

	// --- Live announcement region exists and is polite ---
	// (The guided-test panel provides one whenever a test runs; the generic
	// table always renders the event log as history.)
	await expect(gmPage.getByTestId('declare-test').first()).toBeVisible();
	await gmPage.getByTestId('declare-test-tenure').first().selectOption({ index: 1 });
	const [declared] = await Promise.all([
		gmPage.waitForResponse((res) => res.url().includes('/guided-test-commands'), { timeout: 8000 }),
		gmPage.getByTestId('declare-test').first().click()
	]);
	expect(declared.ok()).toBe(true);
	const status = playerAPage.getByTestId('test-announcement').first();
	await expect(status).toHaveAttribute('aria-live', 'polite', { timeout: 6000 });
	await expect(status).toHaveAttribute('role', 'status');

	await gm.close();
	await playerA.close();
	await playerB.close();
});
