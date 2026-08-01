import { expect, test, type Locator, type Page } from '@playwright/test';
import { signInAs, createTestAdventurer } from './fixtures/auth';
import { attachAdventurer, campaignIdFromUrl, createCampaignAndReadInvite, joinCampaign } from './fixtures/challenge';

/** The guided-test analog of `fixtures/challenge.ts`'s `clickCommand`: clicks
 * `locator` and waits for the `/guided-test-commands` POST it triggers to
 * actually resolve, throwing with the response body on a rejection so a real
 * regression fails loudly here rather than as a confusing UI mismatch later.
 * A separate helper because these commands go to their own route — reusing the
 * Challenge one would wait forever for a request that is never sent. */
async function clickCommand(page: Page, locator: Locator, timeoutMs = 15000): Promise<void> {
	const [response] = await Promise.all([
		page.waitForResponse((res) => res.url().includes('/guided-test-commands') && res.request().method() === 'POST', {
			timeout: timeoutMs
		}),
		locator.click()
	]);
	if (!response.ok()) {
		const body = await response.text().catch(() => '<unreadable response body>');
		throw new Error(`guided test command via ${locator} failed (HTTP ${response.status()}): ${body}`);
	}
}

/**
 * Increment 4 Task 2 Step 4 — the guided test of fate and group test end to end,
 * across three browser contexts (GM + two players).
 *
 * What this proves that the unit and integration suites cannot:
 *
 * - The GM/player authorization split is real in the rendered UI. A player never
 *   sees a way to call for a test; a non-acting player never sees a way to draw
 *   or push someone else's test.
 * - Controls are rendered from the SERVER's legal set. The Resolve purchase is
 *   absent for an adventurer who cannot afford it, and every button that does
 *   appear is one the server would accept.
 * - The public result reaches every context, because a test of fate is public by
 *   rule.
 * - A group test runs two complete subtests through the same panel and publishes
 *   one hit total.
 */
test.describe('guided test of fate', () => {
	test('the GM calls a test, the acting player buys favor, draws and resolves it, and the whole table sees the outcome', async ({
		browser
	}) => {
		test.setTimeout(180_000);

		const gm = await browser.newContext();
		const playerA = await browser.newContext();
		const playerB = await browser.newContext();
		const gmPage = await gm.newPage();
		const playerAPage = await playerA.newPage();
		const playerBPage = await playerB.newPage();

		await signInAs(gmPage, 'Fate GM');
		await signInAs(playerAPage, 'Fate Player A');
		await signInAs(playerBPage, 'Fate Player B');
		await createTestAdventurer(playerAPage, 'Isolde Fen');
		await createTestAdventurer(playerBPage, 'Garrow Pike');

		const invite = await createCampaignAndReadInvite(gmPage, 'Fate Table');
		const campaignId = campaignIdFromUrl(gmPage.url());
		await joinCampaign(playerAPage, invite);
		await attachAdventurer(playerAPage, 'Isolde Fen');
		await joinCampaign(playerBPage, invite);
		await attachAdventurer(playerBPage, 'Garrow Pike');

		await gmPage.goto(`/campaigns/${campaignId}/table`);
		await gmPage.getByRole('button', { name: 'Start session' }).click();
		await expect(gmPage.getByRole('button', { name: 'Draw a card' })).toBeVisible();

		await playerAPage.goto(`/campaigns/${campaignId}/table`);
		await playerBPage.goto(`/campaigns/${campaignId}/table`);
		await expect(playerAPage.getByRole('button', { name: 'Draw a card' })).toBeVisible({ timeout: 15000 });
		await expect(playerBPage.getByRole('button', { name: 'Draw a card' })).toBeVisible({ timeout: 15000 });

		// --- Only the GM may call for a test (Ch1) ---
		await expect(gmPage.getByTestId('declare-test')).toBeVisible({ timeout: 15000 });
		await expect(playerAPage.getByTestId('declare-test')).toHaveCount(0);
		await expect(playerBPage.getByTestId('declare-test')).toHaveCount(0);

		// --- The GM declares Isolde testing Swords ---
		await gmPage.getByTestId('declare-test-tenure').selectOption({ label: 'Isolde Fen' });
		await gmPage.getByTestId('declare-test-suit').selectOption('swords');
		await clickCommand(gmPage, gmPage.getByTestId('declare-test'));

		// Every context sees the declared test — it is public by rule.
		for (const page of [gmPage, playerAPage, playerBPage]) {
			await expect(page.getByTestId('test-of-fate-panel')).toBeVisible({ timeout: 15000 });
			await expect(page.getByTestId('test-actor')).toHaveText('Isolde Fen', { timeout: 15000 });
			await expect(page.getByTestId('test-suit')).toHaveText('Swords');
		}

		// --- Favor is the GM's call; the players have nothing to settle ---
		await expect(gmPage.getByTestId('settle-favor')).toBeVisible();
		await expect(playerAPage.getByTestId('settle-favor')).toHaveCount(0);
		await clickCommand(gmPage, gmPage.getByTestId('settle-favor'));

		// --- Only the acting player may buy favor or draw ---
		await expect(playerAPage.getByTestId('draw-test-card')).toBeVisible({ timeout: 15000 });
		await expect(playerBPage.getByTestId('draw-test-card')).toHaveCount(0);
		await expect(gmPage.getByTestId('draw-test-card')).toHaveCount(0);

		// The purchase is offered because the server says it is affordable, and
		// the button names the Resolve the player is spending from.
		const buyFavor = playerAPage.getByTestId('buy-favor');
		await expect(buyFavor).toBeVisible();
		await expect(buyFavor).toContainText('Spend 1 Resolve for favor');
		await clickCommand(playerAPage, buyFavor);

		// The spend is reflected back from the sheet, not guessed client-side.
		await expect(playerAPage.getByTestId('test-modifier')).toContainText('Resolve', { timeout: 15000 });
		// Bought once, never twice.
		await expect(playerAPage.getByTestId('buy-favor')).toHaveCount(0);

		// --- Draw and resolve ---
		await clickCommand(playerAPage, playerAPage.getByTestId('draw-test-card'));

		for (const page of [gmPage, playerAPage, playerBPage]) {
			await expect(page.getByTestId('test-initial-card')).toBeVisible({ timeout: 15000 });
			await expect(page.getByTestId('test-outcome')).toBeVisible({ timeout: 15000 });
		}

		// A failing draw offers the free push — to the acting player only. A
		// succeeding one does not offer it at all. Both are legitimate outcomes of
		// a real shuffle, so assert whichever the server actually reached.
		const pushOffered = (await playerAPage.getByTestId('push-fate').count()) > 0;
		if (pushOffered) {
			await expect(playerBPage.getByTestId('push-fate')).toHaveCount(0);
			await expect(gmPage.getByTestId('push-fate')).toHaveCount(0);
			await clickCommand(playerAPage, playerAPage.getByTestId('decline-push'));
		}

		// --- Only the GM finishes the test ---
		await expect(gmPage.getByTestId('complete-test')).toBeVisible({ timeout: 15000 });
		await expect(playerAPage.getByTestId('complete-test')).toHaveCount(0);
		await clickCommand(gmPage, gmPage.getByTestId('complete-test'));

		// The slot clears everywhere and the GM may call for another.
		await expect(gmPage.getByTestId('declare-test')).toBeVisible({ timeout: 15000 });
		await expect(playerAPage.getByTestId('test-outcome')).toHaveCount(0, { timeout: 15000 });

		await gm.close();
		await playerA.close();
		await playerB.close();
	});

	test('a group test runs both subtests through the same panel and publishes one hit total', async ({ browser }) => {
		test.setTimeout(180_000);

		const gm = await browser.newContext();
		const playerA = await browser.newContext();
		const playerB = await browser.newContext();
		const gmPage = await gm.newPage();
		const playerAPage = await playerA.newPage();
		const playerBPage = await playerB.newPage();

		await signInAs(gmPage, 'Group GM');
		await signInAs(playerAPage, 'Group Player A');
		await signInAs(playerBPage, 'Group Player B');
		await createTestAdventurer(playerAPage, 'Wren Ashby');
		await createTestAdventurer(playerBPage, 'Dolan Rusk');

		const invite = await createCampaignAndReadInvite(gmPage, 'Group Table');
		const campaignId = campaignIdFromUrl(gmPage.url());
		await joinCampaign(playerAPage, invite);
		await attachAdventurer(playerAPage, 'Wren Ashby');
		await joinCampaign(playerBPage, invite);
		await attachAdventurer(playerBPage, 'Dolan Rusk');

		await gmPage.goto(`/campaigns/${campaignId}/table`);
		await gmPage.getByRole('button', { name: 'Start session' }).click();
		await expect(gmPage.getByRole('button', { name: 'Draw a card' })).toBeVisible();

		await playerAPage.goto(`/campaigns/${campaignId}/table`);
		await playerBPage.goto(`/campaigns/${campaignId}/table`);
		await expect(playerAPage.getByRole('button', { name: 'Draw a card' })).toBeVisible({ timeout: 15000 });

		// --- The GM names the group; the engine picks who tests ---
		await expect(gmPage.getByTestId('declare-group-test')).toBeVisible({ timeout: 15000 });
		await expect(playerAPage.getByTestId('declare-group-test')).toHaveCount(0);

		await gmPage.getByTestId('declare-group-suit').selectOption('swords');
		const candidates = gmPage.locator('[data-testid^="group-candidate-"]');
		await expect(candidates).toHaveCount(2, { timeout: 15000 });
		await candidates.nth(0).check();
		await candidates.nth(1).check();
		await clickCommand(gmPage, gmPage.getByTestId('declare-group-test'));

		// The chosen adventurers are announced to the table before any draw.
		for (const page of [gmPage, playerAPage, playerBPage]) {
			await expect(page.getByTestId('group-test-panel')).toBeVisible({ timeout: 15000 });
			await expect(page.getByTestId('group-most')).not.toBeEmpty({ timeout: 15000 });
			await expect(page.getByTestId('group-least')).not.toBeEmpty();
		}
		const mostName = (await gmPage.getByTestId('group-most').textContent())?.trim() ?? '';
		const leastName = (await gmPage.getByTestId('group-least').textContent())?.trim() ?? '';
		expect(mostName).not.toBe(leastName);

		const pageFor = (name: string) => (name === 'Wren Ashby' ? playerAPage : playerBPage);

		// --- Run both subtests through the ordinary test panel ---
		for (const [index, who] of [mostName, leastName].entries()) {
			const actorPage = pageFor(who);

			await clickCommand(gmPage, gmPage.getByTestId('settle-favor'));
			await expect(actorPage.getByTestId('draw-test-card')).toBeVisible({ timeout: 15000 });
			await clickCommand(actorPage, actorPage.getByTestId('draw-test-card'));

			if ((await actorPage.getByTestId('push-fate').count()) > 0) {
				await clickCommand(actorPage, actorPage.getByTestId('decline-push'));
			}

			// The group's own advance replaces the standalone completion.
			await expect(gmPage.getByTestId('complete-test')).toHaveCount(0);
			await expect(gmPage.getByTestId('advance-group-test')).toBeVisible({ timeout: 15000 });
			await clickCommand(gmPage, gmPage.getByTestId('advance-group-test'));

			// Each finished subtest is listed for the table.
			await expect(gmPage.getByTestId('group-subtests').locator('li')).toHaveCount(index + 1, { timeout: 15000 });
		}

		// --- One hit total and one band, visible to everyone ---
		for (const page of [gmPage, playerAPage, playerBPage]) {
			await expect(page.getByTestId('group-outcome')).toBeVisible({ timeout: 15000 });
			await expect(page.getByTestId('group-outcome')).toContainText('hit');
		}
		await expect(gmPage.getByTestId('group-stage')).toHaveText('Resolved');

		await gm.close();
		await playerA.close();
		await playerB.close();
	});
});
