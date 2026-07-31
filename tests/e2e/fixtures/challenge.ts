import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Shared orchestration for the guided Challenge table's E2E specs
 * (`challenge.spec.ts`/`challenge-privacy.spec.ts`). Both specs need the
 * same multi-context setup (campaign, invite, adventurer attach) and the
 * same round-cycling mechanics (deal → place → reveal → begin turns → turns
 * → cleanup) — kept in one place so the two specs can't silently drift on
 * how a round actually advances.
 *
 * Root-cause note (diagnosed after a real failure): every control here that
 * mutates Challenge state posts to `/challenge-commands`. Firing a bare
 * `.click()` and immediately moving on to inspect "whose turn is it now" is
 * a genuine race — the click event dispatches synchronously, but the async
 * command handler (and the resulting store/DOM update) has not necessarily
 * landed yet, so the NEXT check can read the pre-command DOM, "confirm" the
 * same seat is still active, and then have the real response land mid
 * re-interaction — tearing down the `turn-controls` section out
 * from under an in-flight Playwright action ("element was detached from the
 * DOM, retrying"). `clickCommand` below waits for the actual
 * `/challenge-commands` response before returning, so every helper here
 * only ever inspects state AFTER the command it triggered has genuinely
 * landed — a real signal, never an arbitrary `waitForTimeout`.
 */

/** Clicks `locator` and waits for the `/challenge-commands` POST it
 * triggers to actually resolve before returning — the one synchronization
 * primitive every helper below is built on. Throws with the response body
 * if the command was rejected, so a genuine product regression fails loudly
 * here instead of manifesting later as a confusing UI-state mismatch. */
export async function clickCommand(page: Page, locator: Locator, timeoutMs = 15000): Promise<void> {
	const [response] = await Promise.all([
		page.waitForResponse((res) => res.url().includes('/challenge-commands') && res.request().method() === 'POST', { timeout: timeoutMs }),
		locator.click()
	]);
	if (!response.ok()) {
		const body = await response.text().catch(() => '<unreadable response body>');
		throw new Error(`challenge command via ${locator} failed (HTTP ${response.status()}): ${body}`);
	}
}

export async function createCampaignAndReadInvite(page: Page, name: string): Promise<string> {
	await page.goto('/campaigns/new');
	await page.getByLabel('Campaign name').fill(name);
	await page.getByRole('button', { name: 'Create campaign' }).click();
	await page.waitForURL(/\/campaigns\/[^/]+$/);
	return page.getByLabel('Invite link').inputValue();
}

export async function joinCampaign(page: Page, invite: string): Promise<void> {
	await page.goto(invite);
	await page.getByRole('button', { name: 'Join campaign' }).click();
	await expect(page.getByText('Joined without an adventurer')).toBeVisible();
}

export async function attachAdventurer(page: Page, characterName: string): Promise<void> {
	await page.getByLabel('Adventurer', { exact: true }).selectOption({ label: characterName });
	await page.getByRole('button', { name: 'Attach adventurer' }).click();
	// Not "1 active adventurer" — with more than one campaign member
	// attaching, the campaign-wide total (shown in "Guild members") is
	// whatever the CURRENT count is, not necessarily 1. The character's own
	// name appearing in the member list is the actual per-actor signal.
	await expect(page.getByText(characterName, { exact: true })).toBeVisible();
}

export function campaignIdFromUrl(url: string): string {
	const match = url.match(/\/campaigns\/([^/?#]+)/);
	if (!match) throw new Error(`could not read a campaign id from ${url}`);
	return match[1];
}

export async function beginChallenge(
	gmPage: Page,
	characterNames: string[],
	// `size`/`threat` are no longer free text in the UI (review round: a
	// typo silently mis-scored the GM hand-size formula) — `largerThanHuman`
	// drives the checkbox, `threat` selects one of the content pack's real
	// `denizens.json` threat ids (e.g. `'minion'`).
	enemy?: { id: string; typeIds: string; largerThanHuman?: boolean; threat: string; count: string }
): Promise<void> {
	await expect(gmPage.getByTestId('begin-challenge-form')).toBeVisible();
	for (const name of characterNames) {
		await gmPage.locator('label.participant', { hasText: name }).locator('input[type="checkbox"]').check();
	}
	if (enemy) {
		await gmPage.getByRole('button', { name: 'Add enemy fact' }).click();
		const row = gmPage.getByTestId('enemy-draft-row').first();
		await row.getByLabel('Enemy id').fill(enemy.id);
		await row.getByLabel('Enemy type ids (comma-separated)').fill(enemy.typeIds);
		if (enemy.largerThanHuman) await row.getByLabel('Larger than a human').check();
		await row.getByLabel('Enemy threat').selectOption(enemy.threat);
		await row.getByLabel('Enemy headcount').fill(enemy.count);
	}
	await clickCommand(gmPage, gmPage.getByTestId('begin-challenge-button'));
}

export async function waitForStage(pages: Page[], label: string, timeoutMs = 6000): Promise<void> {
	for (const page of pages) {
		await expect(page.getByTestId('challenge-stage')).toHaveText(label, { timeout: timeoutMs });
	}
}

export async function dealRound(gmPage: Page, otherPages: Page[]): Promise<void> {
	await expect(gmPage.getByRole('button', { name: 'Deal Challenge cards' })).toBeVisible({ timeout: 15000 });
	await clickCommand(gmPage, gmPage.getByRole('button', { name: 'Deal Challenge cards' }));
	await waitForStage([gmPage, ...otherPages], 'Placing Initiative', 6000);
}

/**
 * Each player places a hand card as Initiative — the FIRST hand card by
 * default, or (when `avoidFool` is set) the first NON-Fool card when one is
 * available. Root-cause note: every caller that hunts for a Fool paired
 * play (`runRoundsUntilFoolPaired`/the Fool branch of `playAllTurns`, and
 * `challenge-privacy.spec.ts`'s own Fool-hunt loop) needs the Fool to still
 * be IN HAND once turns begin; if this helper blindly placed the hand's
 * first card and that happened to be the Fool, it would be spent on
 * Initiative before the turn loop ever saw it — `foolSeen` (checked against
 * the pre-placement initiative hand) would still report true, but no
 * pairing could ever happen that round, and `runRoundsUntilFoolPaired`
 * would return having accomplished nothing. `avoidFool` defaults to false
 * so callers that read a card's identity via `.first()` BEFORE calling this
 * (e.g. the privacy spec's checkpoint 1 canary) keep placing exactly the
 * card they inspected. */
export async function placeAllPlayerInitiative(playerPages: Page[], options: { avoidFool?: boolean } = {}): Promise<void> {
	for (const page of playerPages) {
		await expect(page.getByTestId('initiative-placement-controls')).toBeVisible({ timeout: 15000 });
		const handCards = page.getByTestId('initiative-hand-card');
		let target = handCards.first();
		if (options.avoidFool) {
			const nonFoolCards = handCards.filter({ hasNot: page.locator('[data-card-id="fool"]') });
			if ((await nonFoolCards.count()) > 0) target = nonFoolCards.first();
		}
		await clickCommand(page, target.getByRole('button', { name: 'Place as Initiative' }));
	}
}

/** GM places the named enemy fact's Initiative from the GM hand. */
export async function placeGmInitiative(gmPage: Page, enemyId: string): Promise<void> {
	await expect(gmPage.getByTestId('gm-initiative-form')).toBeVisible({ timeout: 15000 });
	const select = gmPage.locator(`select[aria-label="Initiative card for ${enemyId}"]`);
	const firstRealOption = await select.locator('option').nth(1).getAttribute('value');
	if (!firstRealOption) throw new Error('GM hand has no cards to place as enemy Initiative');
	await select.selectOption(firstRealOption);
	await clickCommand(gmPage, gmPage.locator('.enemy-placement', { hasText: enemyId }).getByRole('button', { name: 'Place' }));
}

export async function revealAndBeginTurns(gmPage: Page, otherPages: Page[]): Promise<void> {
	await expect(gmPage.getByRole('button', { name: 'Reveal Initiative' })).toBeVisible({ timeout: 15000 });
	await clickCommand(gmPage, gmPage.getByRole('button', { name: 'Reveal Initiative' }));
	await waitForStage([gmPage, ...otherPages], 'Initiative revealed', 6000);
	await clickCommand(gmPage, gmPage.getByRole('button', { name: 'Begin turns' }));
}

async function anyPageShowsTurnControls(pages: Page[], timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		for (const page of pages) {
			if (await page.getByTestId('turn-controls').isVisible().catch(() => false)) return true;
		}
		if (Date.now() > deadline) return false;
		await pages[0].waitForTimeout(150);
	}
}

/**
 * Waits up to `timeoutMs` for SOME page in `pages` to show `turn-controls`
 * WITH real cards (`turn-hand-card`) — the genuinely active participant's
 * own turn, as opposed to the GM's bare oversight override (see
 * `playAllTurns`'s doc comment). Polling, not a one-shot check: the actual
 * active participant's own client only learns of a NEW active turn via
 * their own next `/sync` poll (up to ~1.15s away), which can easily still
 * be in flight the instant this looks. */
async function findActingPage(pages: Page[], timeoutMs: number): Promise<Page | null> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		for (const page of pages) {
			if (!(await page.getByTestId('turn-controls').isVisible().catch(() => false))) continue;
			if ((await page.getByTestId('turn-hand-card').count()) > 0) return page;
		}
		if (Date.now() > deadline) return null;
		await pages[0].waitForTimeout(150);
	}
}

/** Whichever of `pages` currently shows `turn-controls` takes its turn:
 * plays its first hand card if a "Play" button is offered, then ends the
 * turn — UNLESS that hand holds the Fool, in which case it pairs the Fool
 * with another card instead (`onFool` is called once, right before ending
 * that turn, so a caller can assert mid-Fool-play state before the extra
 * turn it schedules is itself taken). Every state-mutating click waits for
 * its own command response (`clickCommand`) before the loop re-inspects
 * which page is active next — see the file header for why that matters.
 * Loops until no page shows `turn-controls` at all (turns exhausted for
 * this round — robust to a Fool-inserted extra turn changing the total
 * count).
 *
 * Root-cause note (review round, `TurnControls.svelte`'s O1 fix): the GM's
 * `turn-controls` section is now visible whenever `end-turn` is offered —
 * which `legalChallengeBaseCommands` offers the GM for ANY active turn (their
 * own oversight authority to end anyone's turn), not only their own enemy's.
 * So during an ordinary PLAYER's turn, the GM's page ALSO shows
 * `turn-controls` — a bare "End turn" override, no hand cards — often before
 * the actually-active player's OWN client has even polled its new turn into
 * view. A first attempt at this fix picked whichever page merely had
 * `turn-hand-card`S *right now*, falling back to the GM's override the
 * instant no page had any yet — but that raced the active player's own poll
 * every time and let the GM's override silently end EVERY turn in the round
 * before any player ever got to act (confirmed by direct reproduction: the
 * GM's page cycled through all three Initiative seats itself, `stage` never
 * advancing on either player's OWN client, which stayed on "Initiative
 * revealed" for the whole round). `findActingPage` above polls for a page
 * with real cards for a real budget (letting the active client's own poll
 * catch up) before this function ever falls back to ending whichever bare
 * `turn-controls` is visible at all. */
export async function playAllTurns(pages: Page[], onFool?: (page: Page) => Promise<void>): Promise<void> {
	while (await anyPageShowsTurnControls(pages, 6000)) {
		let acted = false;
		const actingPage = await findActingPage(pages, 4000);

		if (actingPage) {
			const handCards = actingPage.getByTestId('turn-hand-card');
			const foolCard = handCards.locator('[data-card-id="fool"]');
			if ((await foolCard.count()) > 0 && (await actingPage.getByTestId('play-fool-toggle').count()) > 0) {
				await actingPage.getByTestId('play-fool-toggle').click();
				const pairButton = actingPage.getByTestId('turn-hand-card').getByRole('button', { name: 'Pair with Fool' }).first();
				await clickCommand(actingPage, pairButton);
				if (onFool) await onFool(actingPage);
				await clickCommand(actingPage, actingPage.getByTestId('end-turn-button'));
			} else {
				const playButton = handCards.first().getByRole('button', { name: 'Play', exact: true });
				if (await playButton.isVisible().catch(() => false)) await clickCommand(actingPage, playButton);
				await clickCommand(actingPage, actingPage.getByTestId('end-turn-button'));
			}
			acted = true;
		} else {
			// No page showed real cards within budget — a genuinely
			// empty-handed active turn, or nothing left but the GM's
			// oversight override. Either way, end whichever `turn-controls`
			// is visible at all.
			for (const page of pages) {
				if (!(await page.getByTestId('turn-controls').isVisible().catch(() => false))) continue;
				if (await page.getByTestId('end-turn-button').isVisible().catch(() => false)) {
					await clickCommand(page, page.getByTestId('end-turn-button'));
					acted = true;
				}
				break;
			}
		}

		if (!acted) break;
	}
}

export async function endRound(gmPage: Page, otherPages: Page[]): Promise<void> {
	// `getByRole('button', { name: 'End round' })` is ambiguous — the
	// generic `PhaseRail` (Increment 2) has its OWN "End round" button for
	// the shared table's own `end-round` command, unrelated to Challenge.
	// Scope to the Challenge panel's own `cleanup-round-button` explicitly.
	const button = gmPage.getByTestId('cleanup-round-button');
	await expect(button).toBeVisible({ timeout: 15000 });
	await clickCommand(gmPage, button);
	await waitForStage([gmPage, ...otherPages], 'Dealing Challenge cards', 6000);
}

/**
 * Runs deal → place → reveal → turns → cleanup for one full round. When
 * `enemy` is supplied, the GM also places and plays that enemy's seat
 * (demonstrating a GM Doom play/discard within the same loop `playAllTurns`
 * already drives). Returns whether the Fool was seen (and paired) this
 * round.
 */
export async function runOneRound(
	gmPage: Page,
	playerPages: Page[],
	options: { enemyId?: string; onFool?: (page: Page) => Promise<void> } = {}
): Promise<boolean> {
	await dealRound(gmPage, playerPages);

	let foolSeen = false;
	for (const page of playerPages) {
		if ((await page.getByTestId('initiative-hand-card').locator('[data-card-id="fool"]').count()) > 0) foolSeen = true;
	}

	// `avoidFool: true` — this helper exists ONLY to hunt for a Fool paired
	// play (see `runRoundsUntilFoolPaired` below), so the Fool must survive
	// placement and still be in the TURN hand when `playAllTurns` runs.
	await placeAllPlayerInitiative(playerPages, { avoidFool: true });
	if (options.enemyId) await placeGmInitiative(gmPage, options.enemyId);
	await revealAndBeginTurns(gmPage, playerPages);
	await playAllTurns([gmPage, ...playerPages], options.onFool);
	await endRound(gmPage, playerPages);
	return foolSeen;
}

/** Loops `runOneRound` until the Fool appears in some player's dealt hand
 * and is paired, bounded by `maxRounds` so a genuine defect fails loudly
 * instead of hanging (the shared player deck auto-reshuffles from discard
 * whenever the draw pile alone is insufficient — `shuffle.ts`'s
 * `drawWithReshuffle` — so this converges reliably in practice).
 *
 * `enemyId`, when the ORIGINAL round began with an enemy fact, MUST be
 * passed on every subsequent round too — `cleanupRound`'s own carry-forward
 * (`nextEnemyFacts = options.enemyFacts ?? challenge.enemyFacts`) means an
 * enemy fact introduced once keeps requiring a GM Initiative placement every
 * round after, since nothing in this UI clears it. Omit only when the round
 * genuinely began with no enemies at all. */
export async function runRoundsUntilFoolPaired(
	gmPage: Page,
	playerPages: Page[],
	onFool: (page: Page) => Promise<void>,
	options: { enemyId?: string; maxRounds?: number } = {}
): Promise<void> {
	const maxRounds = options.maxRounds ?? 15;
	for (let round = 0; round < maxRounds; round++) {
		const foolSeen = await runOneRound(gmPage, playerPages, { enemyId: options.enemyId, onFool });
		if (foolSeen) return;
	}
	throw new Error(`the Fool did not appear in any hand within ${maxRounds} rounds`);
}
