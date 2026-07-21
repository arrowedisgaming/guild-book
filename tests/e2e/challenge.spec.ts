import { expect, test } from '@playwright/test';
import { signInAs, createTestAdventurer } from './fixtures/auth';
import {
	attachAdventurer,
	beginChallenge,
	campaignIdFromUrl,
	clickCommand,
	createCampaignAndReadInvite,
	dealRound,
	joinCampaign,
	placeAllPlayerInitiative,
	placeGmInitiative,
	playAllTurns,
	revealAndBeginTurns,
	endRound,
	runRoundsUntilFoolPaired,
	waitForStage
} from './fixtures/challenge';

/**
 * TDD Step 1 (task-6-brief): the full guided Challenge journey across three
 * browser contexts (GM + two players) — the GM starts Challenge, enters a
 * typed enemy fact, deals, both players place Initiative, the GM reveals,
 * participants take turns (including the GM playing/discarding a Doom), one
 * player performs a Fool paired play, and the round ends and reshuffles into
 * the next. Every assertion below is driven by what the projection actually
 * rendered (`challenge-stage`, `initiative-order`, `turn-controls`,
 * `legalCommands`-gated buttons) — never a client-side legality guess.
 *
 * "Challenge completes" (the plan's original Step 1 wording) is NOT asserted
 * here: Tasks 2/3 established, and review accepted, that nothing in the
 * engine currently transitions `stage` to `'complete'` — the round cycle
 * (deal → place → reveal → turns → cleanup → deal again) is the actual,
 * reachable lifecycle. Inventing a completion transition would be new engine
 * behavior this task was not asked to add (O5).
 */
test.describe('guided Challenge table', () => {
	test('the full journey: begin with an enemy, deal, place, reveal, GM Doom play/discard, a Fool paired play, and a round transition', async ({
		browser
	}) => {
		test.setTimeout(180_000);

		const gm = await browser.newContext();
		const playerA = await browser.newContext();
		const playerB = await browser.newContext();
		const gmPage = await gm.newPage();
		const playerAPage = await playerA.newPage();
		const playerBPage = await playerB.newPage();

		await signInAs(gmPage, 'Challenge GM');
		await signInAs(playerAPage, 'Challenge Player A');
		await signInAs(playerBPage, 'Challenge Player B');
		await createTestAdventurer(playerAPage, 'Mara Vey');
		await createTestAdventurer(playerBPage, 'Toma Dree');

		const invite = await createCampaignAndReadInvite(gmPage, 'Challenge Table');
		const campaignId = campaignIdFromUrl(gmPage.url());
		await joinCampaign(playerAPage, invite);
		await attachAdventurer(playerAPage, 'Mara Vey');
		await joinCampaign(playerBPage, invite);
		await attachAdventurer(playerBPage, 'Toma Dree');

		await gmPage.goto(`/campaigns/${campaignId}/table`);
		await gmPage.getByRole('button', { name: 'Start session' }).click();
		await expect(gmPage.getByRole('button', { name: 'Draw a card' })).toBeVisible();

		await playerAPage.goto(`/campaigns/${campaignId}/table`);
		await playerBPage.goto(`/campaigns/${campaignId}/table`);
		await expect(playerAPage.getByRole('button', { name: 'Draw a card' })).toBeVisible({ timeout: 2000 });
		await expect(playerBPage.getByRole('button', { name: 'Draw a card' })).toBeVisible({ timeout: 2000 });

		// Before any round begins, neither player sees ANY Challenge UI —
		// `challengeLegalCommands` is empty for them (only the GM may begin).
		await expect(playerAPage.getByTestId('challenge-panel')).toHaveCount(0);
		await expect(playerBPage.getByTestId('challenge-panel')).toHaveCount(0);

		// --- The GM starts Challenge with a typed enemy fact ---
		await beginChallenge(gmPage, ['Mara Vey', 'Toma Dree'], {
			id: 'ogre-1',
			typeIds: 'ogre',
			size: 'human',
			threat: 'minion',
			count: '1'
		});
		await waitForStage([gmPage, playerAPage, playerBPage], 'Dealing Challenge cards');

		// --- Deal ---
		await dealRound(gmPage, [playerAPage, playerBPage]);

		// --- Place Initiative (both players, then the GM's enemy) ---
		await placeAllPlayerInitiative([playerAPage, playerBPage]);
		await placeGmInitiative(gmPage, 'ogre-1');

		// --- Reveal — every context sees the same 3-seat order ---
		await revealAndBeginTurns(gmPage, [playerAPage, playerBPage]);
		for (const page of [gmPage, playerAPage, playerBPage]) {
			await expect(page.getByTestId('initiative-row')).toHaveCount(3, { timeout: 2000 });
		}

		// --- Take turns: whoever is active plays and ends their turn; the GM's
		// enemy turn (playing a Doom) is exercised through the identical
		// `turn-controls` surface every other seat uses. Pairs the Fool
		// immediately if it happens to be dealt this round. ---
		let foolPaired = false;
		await playAllTurns([gmPage, playerAPage, playerBPage], async () => {
			foolPaired = true;
		});

		// --- The GM discards a Doom from their hand (available any time during
		// turns, independent of whose turn is active) ---
		await expect(gmPage.getByTestId('gm-discard-form')).toBeVisible();
		const gmDiscardSelect = gmPage.locator('select[aria-label="Card to discard from the GM hand"]');
		const gmDiscardOption = await gmDiscardSelect.locator('option').nth(1).getAttribute('value');
		if (gmDiscardOption) {
			await gmDiscardSelect.selectOption(gmDiscardOption);
			await clickCommand(gmPage, gmPage.getByRole('button', { name: 'Discard from GM hand' }));
		}

		// --- End the round; confirm the round counter advances (the "round
		// ends/reshuffles" step) ---
		await endRound(gmPage, [playerAPage, playerBPage]);
		await expect(gmPage.getByRole('heading', { name: 'Challenge — Round 2' })).toBeVisible();

		// --- If the Fool didn't happen to appear in round 1, keep cycling
		// enemy-free rounds until it does, to prove the Fool paired-play
		// mechanic end to end through the real UI (not just unit fixtures). ---
		if (!foolPaired) {
			// The 'ogre-1' enemy fact persists across rounds (`cleanupRound`
			// carries it forward — there is no "clear enemies" control in this
			// UI), so every subsequent round still needs the GM's own
			// Initiative placement for it.
			await runRoundsUntilFoolPaired(gmPage, [playerAPage, playerBPage], async () => {
				foolPaired = true;
			}, { enemyId: 'ogre-1' });
		}
		expect(foolPaired).toBe(true);

		await gm.close();
		await playerA.close();
		await playerB.close();
	});
});
