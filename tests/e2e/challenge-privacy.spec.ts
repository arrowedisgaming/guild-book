import { expect, test, type Page } from '@playwright/test';
import { signInAs, createTestAdventurer } from './fixtures/auth';
import {
	attachAdventurer,
	beginChallenge,
	campaignIdFromUrl,
	clickCommand,
	createCampaignAndReadInvite,
	dealRound,
	endRound,
	joinCampaign,
	placeAllPlayerInitiative,
	revealAndBeginTurns,
	waitForStage
} from './fixtures/challenge';

/**
 * TDD Step 1 (task-6-brief) / O10: the guided Challenge table's privacy
 * discipline, examined at both the response-body and DOM level, at every
 * stage the brief names — before and after: initiative reveal, a private
 * transfer (Counsel), Stun, and a Fool paired play. Mirrors
 * `shared-table-privacy.spec.ts`'s canary pattern: a unique card identity
 * (its content-hydrated label, never guessable) must be absent from every
 * OTHER client's collected network responses and rendered DOM until the
 * moment the rule itself says it becomes public — then, and only then, it
 * may appear.
 */
const CROSS_CLIENT_BUDGET_MS = 2000;

/** Collects every response body text from Challenge-related requests
 * (`/sync`, `/challenge-commands`) for later canary scanning — attach BEFORE
 * any interaction so nothing is missed. */
function collectResponses(page: Page): string[] {
	const bodies: string[] = [];
	page.on('response', (response) => {
		const url = response.url();
		if (!url.includes('/sync') && !url.includes('/challenge-commands')) return;
		response
			.text()
			.then((text) => bodies.push(text))
			.catch(() => {});
	});
	return bodies;
}

/**
 * `sinceIndex` (default 0, the whole collected history) lets a caller scope
 * the check to responses collected from a given point forward. Needed by
 * the Fool-hunt loop below: the shared deck is a FINITE, fixed set of ~78
 * uniquely-labeled tarot cards, and hunting the Fool across up to 15 rounds
 * relies on the deck's own auto-reshuffle from discard — so the exact same
 * physical card (same label) legitimately becomes public in one round, is
 * reshuffled, and is then dealt back into a DIFFERENT, brand-new private
 * hand in a later round. Checking the FULL history for that later hand's
 * canary would find its own label's earlier, already-legitimate public
 * appearance and report a false leak. Scoping to "since this round's deal"
 * checks only what matters: has the CURRENT private instance leaked yet.
 */
async function assertCanaryAbsent(page: Page, responses: string[], canary: string, sinceIndex = 0): Promise<void> {
	expect(responses.slice(sinceIndex).some((body) => body.includes(canary))).toBe(false);
	const content = await page.content();
	expect(content).not.toContain(canary);
}

async function assertCanaryPresentEventually(
	page: Page,
	responses: () => string[],
	canary: string,
	timeoutMs = CROSS_CLIENT_BUDGET_MS,
	sinceIndex = 0
): Promise<void> {
	await expect
		.poll(
			async () => {
				const content = await page.content();
				return content.includes(canary) || responses().slice(sinceIndex).some((body) => body.includes(canary));
			},
			{ timeout: timeoutMs }
		)
		.toBe(true);
}

test.describe('guided Challenge table privacy', () => {
	test('unique hand-card canaries never leak before their rule-defined disclosure point, at initiative reveal, a private transfer, Stun, and a Fool paired play', async ({
		browser
	}) => {
		test.setTimeout(180_000);

		const gm = await browser.newContext();
		const playerA = await browser.newContext();
		const playerB = await browser.newContext();
		const gmPage = await gm.newPage();
		const playerAPage = await playerA.newPage();
		const playerBPage = await playerB.newPage();

		const gmResponses = collectResponses(gmPage);
		const aResponses = collectResponses(playerAPage);
		const bResponses = collectResponses(playerBPage);
		const consoleTexts: string[] = [];
		for (const page of [gmPage, playerAPage, playerBPage]) {
			page.on('console', (message) => consoleTexts.push(message.text()));
		}

		await signInAs(gmPage, 'Privacy Challenge GM');
		await signInAs(playerAPage, 'Privacy Challenge Player A');
		await signInAs(playerBPage, 'Privacy Challenge Player B');
		await createTestAdventurer(playerAPage, 'Privacy Hero A');
		await createTestAdventurer(playerBPage, 'Privacy Hero B');

		const invite = await createCampaignAndReadInvite(gmPage, 'Privacy Challenge Table');
		const campaignId = campaignIdFromUrl(gmPage.url());
		await joinCampaign(playerAPage, invite);
		await attachAdventurer(playerAPage, 'Privacy Hero A');
		await joinCampaign(playerBPage, invite);
		await attachAdventurer(playerBPage, 'Privacy Hero B');

		await gmPage.goto(`/campaigns/${campaignId}/table`);
		await gmPage.getByRole('button', { name: 'Start session' }).click();
		await expect(gmPage.getByRole('button', { name: 'Draw a card' })).toBeVisible();
		await playerAPage.goto(`/campaigns/${campaignId}/table`);
		await playerBPage.goto(`/campaigns/${campaignId}/table`);
		await expect(playerAPage.getByRole('button', { name: 'Draw a card' })).toBeVisible({ timeout: 2000 });
		await expect(playerBPage.getByRole('button', { name: 'Draw a card' })).toBeVisible({ timeout: 2000 });

		// No enemies — keeps every round's turn order to exactly the two
		// players, simplifying the Fool-hunt loop below.
		await beginChallenge(gmPage, ['Privacy Hero A', 'Privacy Hero B']);
		await waitForStage([gmPage, playerAPage, playerBPage], 'Dealing Challenge cards');
		await dealRound(gmPage, [playerAPage, playerBPage]);

		// ---------------------------------------------------------------
		// Checkpoint 1: Initiative reveal — hidden before, disclosed after.
		// ---------------------------------------------------------------
		const aInitiativeCard = playerAPage.getByTestId('initiative-hand-card').first().locator('.card');
		const aCanary = await aInitiativeCard.getAttribute('aria-label');
		expect(aCanary).toBeTruthy();
		const bInitiativeCard = playerBPage.getByTestId('initiative-hand-card').first().locator('.card');
		const bCanary = await bInitiativeCard.getAttribute('aria-label');
		expect(bCanary).toBeTruthy();

		await placeAllPlayerInitiative([playerAPage, playerBPage]);

		// Before reveal: neither placed card's identity is visible to the GM
		// or to the OTHER player, in DOM or in any collected response.
		await assertCanaryAbsent(gmPage, gmResponses, aCanary as string);
		await assertCanaryAbsent(gmPage, gmResponses, bCanary as string);
		await assertCanaryAbsent(playerBPage, bResponses, aCanary as string);
		await assertCanaryAbsent(playerAPage, aResponses, bCanary as string);

		await revealAndBeginTurns(gmPage, [playerAPage, playerBPage]);

		// After reveal: both cards are now legitimately public (the whole
		// point of Initiative reveal).
		await assertCanaryPresentEventually(gmPage, () => gmResponses, aCanary as string);
		await assertCanaryPresentEventually(gmPage, () => gmResponses, bCanary as string);
		await assertCanaryPresentEventually(playerBPage, () => bResponses, aCanary as string);
		await assertCanaryPresentEventually(playerAPage, () => aResponses, bCanary as string);

		// ---------------------------------------------------------------
		// Checkpoint 2: Counsel (a private transfer) — the recipient sees it;
		// the GM never does. Counsel carries no stage/turn gate of its own
		// (`transfers.ts`'s `counselTransfer` — "Any time during a
		// Challenge"), so either player may send regardless of whose turn is
		// active; Player A sends to Player B unconditionally.
		// ---------------------------------------------------------------
		const senderPage = playerAPage;
		const recipientPage = playerBPage;
		const recipientResponses = bResponses;

		await expect(senderPage.getByTestId('modifier-counsel')).toBeVisible({ timeout: CROSS_CLIENT_BUDGET_MS });
		// Scoped to the "Card to hand over" select specifically — the
		// "Counsel recipient" select sits earlier in the SAME container and
		// its options are user ids, not card ids; an unscoped `option`
		// locator's `.first()` would silently grab one of THOSE instead.
		const counselHandCard = senderPage
			.locator('[data-testid="modifier-counsel"] select[aria-label="Card to hand over"] option[value]:not([value=""])')
			.first();
		const counselCanary = await counselHandCard.textContent();
		expect(counselCanary).toBeTruthy();
		const counselCardValue = await counselHandCard.getAttribute('value');

		const recipientOptions = senderPage.locator('[data-testid="modifier-counsel"] select[aria-label="Counsel recipient"] option');
		const recipientOptionCount = await recipientOptions.count();
		expect(recipientOptionCount).toBeGreaterThan(1);
		const recipientUserId = await recipientOptions.nth(1).getAttribute('value');

		await senderPage.locator('[data-testid="modifier-counsel"] select[aria-label="Counsel recipient"]').selectOption(recipientUserId as string);
		await senderPage.locator('[data-testid="modifier-counsel"] select[aria-label="Card to hand over"]').selectOption(counselCardValue as string);
		await clickCommand(senderPage, senderPage.locator('[data-testid="modifier-counsel"]').getByRole('button', { name: 'Give advice' }));

		// The GM must NEVER see the transferred card's identity.
		await assertCanaryAbsent(gmPage, gmResponses, counselCardValue as string);

		// The recipient DOES receive it into their own hand (their own
		// private response payload carries `cardId`).
		await expect
			.poll(() => recipientResponses.some((body) => body.includes(counselCardValue as string)), { timeout: CROSS_CLIENT_BUDGET_MS })
			.toBe(true);

		// ---------------------------------------------------------------
		// Checkpoint 3: Stun — the target's own choice; never the GM's. Stun
		// carries no stage/turn gate either (`applyStun` — "immediately",
		// Ch1 — is offered to the GM whenever a round exists), so the GM
		// targets whichever tenure the roster's own select offers first; the
		// resolving page is discovered afterward rather than guessed.
		// ---------------------------------------------------------------
		const stunTenureSelect = gmPage.locator('[data-testid="modifier-stun-record"] select[aria-label="Stun target"]');
		const stunTenureOptions = stunTenureSelect.locator('option');
		// Target whichever tenure owns the page under test — resolved via the
		// select's own option list rather than guessed.
		const stunOptionValues = await stunTenureOptions.evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value));
		const targetTenureId = stunOptionValues.find((value) => value !== '');
		expect(targetTenureId).toBeTruthy();
		await stunTenureSelect.selectOption(targetTenureId as string);
		await clickCommand(gmPage, gmPage.locator('[data-testid="modifier-stun-record"]').getByRole('button', { name: 'Record Stun' }));

		// Whichever page actually holds that tenure sees the resolve form —
		// discovered, never guessed. `isVisible()` alone does NOT wait (its
		// `timeout` option is deprecated and ignored — Playwright checks and
		// returns immediately), which raced the target's own next `/sync`
		// poll picking up the GM's just-recorded Stun; `waitFor` genuinely
		// polls until the state is reached (or the budget elapses).
		let resolvingPage: Page | null = null;
		for (const candidate of [playerAPage, playerBPage]) {
			const appeared = await candidate
				.getByTestId('modifier-stun-resolve')
				.waitFor({ state: 'visible', timeout: CROSS_CLIENT_BUDGET_MS })
				.then(() => true)
				.catch(() => false);
			if (appeared) {
				resolvingPage = candidate;
				break;
			}
		}
		if (!resolvingPage) throw new Error('no page shows the Stun resolve form after the GM recorded it');

		const stunCardOption = resolvingPage.locator('[data-testid="modifier-stun-resolve"] option[value]:not([value=""])').first();
		const stunCanary = await stunCardOption.getAttribute('value');
		expect(stunCanary).toBeTruthy();

		// Before resolving: the chosen card is not yet visible to the GM.
		await assertCanaryAbsent(gmPage, gmResponses, stunCanary as string);

		await resolvingPage.locator('[data-testid="modifier-stun-resolve"] select').selectOption(stunCanary as string);
		await clickCommand(resolvingPage, resolvingPage.locator('[data-testid="modifier-stun-resolve"]').getByRole('button', { name: 'Discard' }));

		// The Stun event itself never carries the identity (only a count) —
		// checked at the unit level (`modifiers.test.ts`); here, confirm the
		// discard legitimately becomes visible via the ordinary public
		// discard-top projection shortly after, same as any other discard.
		await assertCanaryPresentEventually(gmPage, () => gmResponses, stunCanary as string);

		// ---------------------------------------------------------------
		// Checkpoint 4: a Fool paired play — private in hand, public once
		// played. Cycles rounds (deck auto-reshuffles from discard) until the
		// Fool is dealt to either player.
		// ---------------------------------------------------------------
		let foolPaired = false;
		for (let round = 0; round < 15 && !foolPaired; round++) {
			await endRound(gmPage, [playerAPage, playerBPage]);
			await dealRound(gmPage, [playerAPage, playerBPage]);

			// This round's fresh deal starts a new "has this specific private
			// card leaked YET" window — see `assertCanaryAbsent`'s doc comment.
			const sinceGm = gmResponses.length;
			const sinceA = aResponses.length;
			const sinceB = bResponses.length;

			let foolPage: Page | null = null;
			for (const page of [playerAPage, playerBPage]) {
				if ((await page.getByTestId('initiative-hand-card').locator('[data-card-id="fool"]').count()) > 0) {
					foolPage = page;
					break;
				}
			}

			// `avoidFool: true` — this loop exists to hunt for a Fool paired
			// play, so the Fool must survive Initiative placement and still be
			// in the turn hand below (see `placeAllPlayerInitiative`'s doc
			// comment in fixtures/challenge.ts for the root-cause this avoids).
			await placeAllPlayerInitiative([playerAPage, playerBPage], { avoidFool: true });
			await revealAndBeginTurns(gmPage, [playerAPage, playerBPage]);

			while (!foolPaired && (await anyoneHasTurnControls([playerAPage, playerBPage]))) {
				for (const page of [playerAPage, playerBPage]) {
					if (!(await page.getByTestId('turn-controls').isVisible().catch(() => false))) continue;
					const otherPage = page === playerAPage ? playerBPage : playerAPage;
					const otherResponses = otherPage === playerAPage ? aResponses : bResponses;
					const sinceOther = otherPage === playerAPage ? sinceA : sinceB;

					const foolCard = page.getByTestId('turn-hand-card').locator('[data-card-id="fool"]');
					if (foolPage === page && (await foolCard.count()) > 0 && (await page.getByTestId('play-fool-toggle').count()) > 0) {
						const pairCandidate = page.getByTestId('turn-hand-card').filter({ hasNot: page.locator('[data-card-id="fool"]') }).first().locator('.card');
						const foolCanary = await pairCandidate.getAttribute('aria-label');
						expect(foolCanary).toBeTruthy();

						// Before playing: the paired card is private to this player.
						await assertCanaryAbsent(gmPage, gmResponses, foolCanary as string, sinceGm);
						await assertCanaryAbsent(otherPage, otherResponses, foolCanary as string, sinceOther);

						await page.getByTestId('play-fool-toggle').click();
						await clickCommand(page, page.getByTestId('turn-hand-card').getByRole('button', { name: 'Pair with Fool' }).first());

						// After playing: publicly played, visible to everyone.
						await assertCanaryPresentEventually(gmPage, () => gmResponses, foolCanary as string, CROSS_CLIENT_BUDGET_MS, sinceGm);
						await assertCanaryPresentEventually(otherPage, () => otherResponses, foolCanary as string, CROSS_CLIENT_BUDGET_MS, sinceOther);

						foolPaired = true;
					} else {
						const handCards = page.getByTestId('turn-hand-card');
						if ((await handCards.count()) > 0) {
							const playButton = handCards.first().getByRole('button', { name: 'Play', exact: true });
							if (await playButton.isVisible().catch(() => false)) await clickCommand(page, playButton);
						}
					}
					await clickCommand(page, page.getByTestId('end-turn-button'));
					break;
				}
			}
		}
		expect(foolPaired).toBe(true);

		// Never leaked to the console on any client either (matching
		// `shared-table-privacy.spec.ts`'s discipline).
		const leaked = consoleTexts.some(
			(text) => text.includes(aCanary as string) || text.includes(bCanary as string)
		);
		expect(leaked).toBe(false);

		await gm.close();
		await playerA.close();
		await playerB.close();
	});
});

async function anyoneHasTurnControls(pages: Page[]): Promise<boolean> {
	const deadline = Date.now() + 6000;
	for (;;) {
		for (const page of pages) {
			if (await page.getByTestId('turn-controls').isVisible().catch(() => false)) return true;
		}
		if (Date.now() > deadline) return false;
		await pages[0].waitForTimeout(150);
	}
}
