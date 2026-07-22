import { describe, expect, it } from 'vitest';
import { getTarotProcedures } from '$lib/server/content/loader';
import { buildChallengeConfig } from '$lib/engine/session/procedures/challenge/schema';
import type { ChallengeConfig, ChallengeEnemyFact } from '$lib/engine/session/procedures/challenge/types';
import {
	beginChallenge,
	CHALLENGE_INITIATIVE_ZONE_ID,
	challengeHandZoneId,
	cleanupRound,
	readChallengeState,
	writeChallengeState,
	type ChallengeReduceContext
} from '$lib/engine/session/procedures/challenge/reducer';
import { dealRound } from '$lib/engine/session/procedures/challenge/deal';
import { placeGmInitiative, placeInitiative, revealInitiative } from '$lib/engine/session/procedures/challenge/initiative';
import {
	activeTurnEntry,
	applyGmDiscard,
	applyGmMinorAction,
	applyGmMulligan,
	applyGmPlay,
	applyPlayerAction,
	applyPlayerMinorAction,
	beginTurns,
	CHALLENGE_PLAYED_ZONE_ID,
	endTurn
} from '$lib/engine/session/procedures/challenge/turns';
import { assertSessionInvariants } from '$lib/engine/session/invariants';
import { findZoneDescriptor } from '$lib/engine/session/state';
import { makeRng } from '$lib/engine/rng';
import { makeRichSessionCatalogFixture, makeSessionFixture } from '../../../fixtures/session';
import type { CardId, SessionActor, SessionEngineStateV1, TarotCardCatalog } from '$lib/types/session';

const GM: SessionActor = { kind: 'gm', userId: 'gm-1' };

/** Tenure ids deliberately distinct from user ids (O7 — a tenure is NEVER a
 * user id). */
const TENURE_OWNERS: Record<string, string> = {
	'tenure-1': 'user-alice',
	'tenure-2': 'user-bob'
};

function ownerOf(tenureId: string): string {
	const owner = TENURE_OWNERS[tenureId];
	if (!owner) throw new Error(`ownerOf: no owner fixture registered for ${tenureId}`);
	return owner;
}

function playerActor(tenureId: string): SessionActor {
	return { kind: 'player', userId: ownerOf(tenureId) };
}

function ctxFor(actor: SessionActor, catalog: TarotCardCatalog, config: ChallengeConfig, seed: string): ChallengeReduceContext {
	return { actor, runtime: { catalog }, rng: makeRng(seed), config };
}

function expectConserved(state: SessionEngineStateV1, catalog: TarotCardCatalog): void {
	expect(() => assertSessionInvariants(state, catalog)).not.toThrow();
}

const oneOgre: ChallengeEnemyFact[] = [{ id: 'ogre-1', size: 'human', threat: 'minion', typeIds: ['ogre'], count: 1 }];

/** Replaces `tenureId`'s ENTIRE hand with exactly `cardIds`, pulling them from
 * wherever they currently sit (the player draw pile, or another tenure's
 * hand) and returning whatever was previously in the target hand back to the
 * draw pile — conserves the fixture's total card count exactly like
 * `round.test.ts`'s `withOnlyCardInZone`, generalized to a full hand. */
function forceHand(state: SessionEngineStateV1, tenureId: string, cardIds: CardId[]): SessionEngineStateV1 {
	const zoneId = challengeHandZoneId(tenureId);
	const zone = findZoneDescriptor(state, zoneId);
	if (!zone) throw new Error(`forceHand: unknown zone ${zoneId}`);

	let playerDraw = state.playerDraw.concat(zone.cards);
	let privateZones = state.privateZones.map((z) => (z.id === zoneId ? { ...z, cards: [] } : z));

	for (const cardId of cardIds) {
		if (playerDraw.includes(cardId)) {
			playerDraw = playerDraw.filter((id) => id !== cardId);
		} else {
			privateZones = privateZones.map((z) => ({ ...z, cards: z.cards.filter((id) => id !== cardId) }));
		}
	}

	const targetIndex = privateZones.findIndex((z) => z.id === zoneId);
	privateZones[targetIndex] = { ...privateZones[targetIndex], cards: cardIds.slice() };

	return { ...state, playerDraw, privateZones };
}

/** Replaces `gmHand` with exactly `cardIds`, symmetric to `forceHand` but for
 * the fixed `gmHand`/`majorDraw` state fields. */
function forceGmHand(state: SessionEngineStateV1, cardIds: CardId[]): SessionEngineStateV1 {
	let majorDraw = state.majorDraw.concat(state.gmHand);
	for (const cardId of cardIds) {
		majorDraw = majorDraw.filter((id) => id !== cardId);
	}
	return { ...state, majorDraw, gmHand: cardIds.slice() };
}

describe('Challenge turns — plays, discards, Dooms, budgets', () => {
	const catalog = makeRichSessionCatalogFixture();
	const { procedures, formulas } = getTarotProcedures();
	const config = buildChallengeConfig(procedures, formulas);

	/** A single-player, no-enemy Challenge ready for `turns`, with tenure-1
	 * holding `hand` (fully available to spend during the test) PLUS a
	 * reserved `wands-king` used only to place Initiative — a distinct card
	 * from anything under test, so a test spending a card from `hand` never
	 * collides with the card already consumed by Initiative placement. */
	function readySoloTurn(seed: string, hand: CardId[]) {
		const state = makeSessionFixture(seed);
		const gmCtx = ctxFor(GM, catalog, config, seed);
		const begun = beginChallenge(state, { participantTenureIds: ['tenure-1'], tenureOwners: TENURE_OWNERS, enemyFacts: [] }, gmCtx);
		if (!begun.ok) throw begun;
		const dealResult = dealRound(begun.state, gmCtx);
		if (!dealResult.ok) throw dealResult;

		const forced = forceHand(dealResult.state, 'tenure-1', ['wands-king', ...hand]);
		const playerCtx = ctxFor(playerActor('tenure-1'), catalog, config, seed);
		const placed = placeInitiative(forced, 'tenure-1', 'wands-king', playerCtx);
		if (!placed.ok) throw placed;
		const revealed = revealInitiative(placed.state, gmCtx);
		if (!revealed.ok) throw revealed;
		const begunTurns = beginTurns(revealed.state, gmCtx);
		if (!begunTurns.ok) throw begunTurns;

		return { state: begunTurns.state, gmCtx, playerCtx };
	}

	/** One player (tenure-1, Initiative reserved to a HIGH card so it goes
	 * LAST) plus one enemy fact (Initiative reserved to a LOW card so the
	 * GM's turn is guaranteed first) — `gmHand` is exactly what remains
	 * available to the GM to spend during the test, distinct from the
	 * reserved Initiative card. */
	function readyGmTurnFirst(seed: string, gmHand: CardId[]) {
		const state = makeSessionFixture(seed);
		const gmCtx = ctxFor(GM, catalog, config, seed);
		const begun = beginChallenge(
			state,
			{ participantTenureIds: ['tenure-1'], tenureOwners: TENURE_OWNERS, enemyFacts: oneOgre },
			gmCtx
		);
		if (!begun.ok) throw begun;
		const dealResult = dealRound(begun.state, gmCtx);
		if (!dealResult.ok) throw dealResult;

		// tenure-1's Initiative card is forced to the highest possible value
		// (King, 14); the ogre's reserved Initiative card ('high-priestess',
		// value 2) is always lower — the ogre always goes first regardless of
		// which cards `gmHand` holds.
		const withPlayerHand = forceHand(dealResult.state, 'tenure-1', ['wands-king', 'cups-ii', 'swords-iii', 'pentacles-iv']);
		const withGmHand = forceGmHand(withPlayerHand, ['high-priestess', ...gmHand]);

		const playerCtx = ctxFor(playerActor('tenure-1'), catalog, config, seed);
		const placedPlayer = placeInitiative(withGmHand, 'tenure-1', 'wands-king', playerCtx);
		if (!placedPlayer.ok) throw placedPlayer;
		const placedGm = placeGmInitiative(placedPlayer.state, 'ogre-1', 'high-priestess', gmCtx);
		if (!placedGm.ok) throw placedGm;
		const revealed = revealInitiative(placedGm.state, gmCtx);
		if (!revealed.ok) throw revealed;
		const begunTurns = beginTurns(revealed.state, gmCtx);
		if (!begunTurns.ok) throw begunTurns;

		return { state: begunTurns.state, gmCtx, playerCtx };
	}

	describe('applyPlayerAction — legal play, no suit constraint (O4)', () => {
		it('plays any card as the turn action regardless of suit, updates budgets, moves the card publicly', () => {
			const { state, playerCtx } = readySoloTurn('action-legal', ['swords-vii', 'cups-ii', 'wands-iii', 'pentacles-iv']);

			const result = applyPlayerAction(state, 'tenure-1', 'swords-vii', playerCtx);
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			expect(readChallengeState(result.state)).toMatchObject({
				budgets: { 'tenure-1': { cardsThisTurn: 1, actionTaken: true, discards: null } }
			});
			expect(result.events.map((e) => e.kind)).toEqual(['challenge-card-played']);
			const played = findZoneDescriptor(result.state, CHALLENGE_PLAYED_ZONE_ID);
			expect(played?.cards).toEqual(['swords-vii']);
			expectConserved(result.state, catalog);
		});

		it('rejects a second play once the per-turn card budget is exhausted', () => {
			const { state, playerCtx } = readySoloTurn('action-exhausted', ['swords-vii', 'cups-ii', 'wands-iii', 'pentacles-iv']);
			const first = applyPlayerAction(state, 'tenure-1', 'swords-vii', playerCtx);
			if (!first.ok) throw first;

			const second = applyPlayerAction(first.state, 'tenure-1', 'cups-ii', playerCtx);
			expect(second).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
		});

		it('rejects a non-owning player', () => {
			const { state } = readySoloTurn('action-not-owner', ['swords-vii', 'cups-ii', 'wands-iii', 'pentacles-iv']);
			const result = applyPlayerAction(state, 'tenure-1', 'swords-vii', ctxFor({ kind: 'player', userId: 'user-bob' }, catalog, config, 'action-not-owner'));
			expect(result).toMatchObject({ ok: false, rejection: { code: 'not-authorized' } });
		});

		it('rejects the Fool played as an ordinary lone action (coordinator follow-up #1 — challenge-the-fool: "always played in conjunction with another card")', () => {
			const { state, playerCtx } = readySoloTurn('action-lone-fool', ['fool', 'cups-ii', 'wands-iii', 'pentacles-iv']);
			const result = applyPlayerAction(state, 'tenure-1', 'fool', playerCtx);
			expect(result).toMatchObject({
				ok: false,
				rejection: { code: 'illegal-command', message: expect.stringContaining('paired-play') }
			});
			// No partial state: the hand still holds the Fool, untouched.
			expect(findZoneDescriptor(state, challengeHandZoneId('tenure-1'))?.cards).toContain('fool');
		});
	});

	describe('applyPlayerMinorAction — suit MUST match (O4)', () => {
		it('accepts a card whose suit matches the declared action suit; does not set actionTaken', () => {
			const { state, playerCtx } = readySoloTurn('minor-match', ['swords-vii', 'cups-ii', 'wands-iii', 'pentacles-iv']);

			const result = applyPlayerMinorAction(state, 'tenure-1', 'cups-ii', 'cups', playerCtx);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(readChallengeState(result.state)).toMatchObject({
				budgets: { 'tenure-1': { cardsThisTurn: 1, actionTaken: false, discards: null } }
			});
			expect(result.events.map((e) => e.kind)).toEqual(['challenge-minor-action-played']);
			expectConserved(result.state, catalog);
		});

		it('rejects a card whose suit does NOT match the declared action suit', () => {
			const { state, playerCtx } = readySoloTurn('minor-mismatch', ['swords-vii', 'cups-ii', 'wands-iii', 'pentacles-iv']);
			const result = applyPlayerMinorAction(state, 'tenure-1', 'swords-vii', 'cups', playerCtx);
			expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
		});

		it('rejects a minor action after the player has already taken a full action this turn (realistic sequence, O1)', () => {
			const { state, playerCtx } = readySoloTurn('minor-after-action', ['swords-vii', 'cups-ii', 'wands-iii', 'pentacles-iv']);
			const acted = applyPlayerAction(state, 'tenure-1', 'swords-vii', playerCtx);
			if (!acted.ok) throw acted;

			const minor = applyPlayerMinorAction(acted.state, 'tenure-1', 'cups-ii', 'cups', playerCtx);
			expect(minor).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
		});

		it('the action/minor-action exclusion fires on its own, independent of the one-card cap (coordinator follow-up #2)', () => {
			// The realistic-sequence test above is byte-identical (same
			// rejection code) to a plain cap-exhaustion rejection, since under
			// the current content cardsPerInitiativeTurn is 1 — so it would
			// still pass even if the exclusion check were deleted. Force
			// `actionTaken: true` while `cardsThisTurn` stays 0 — a combination
			// normal play can never produce under that config — to prove the
			// EXCLUSION rule rejects this on its own, not the numeric cap.
			const { state, playerCtx } = readySoloTurn('minor-exclusion-only', ['swords-vii', 'cups-ii', 'wands-iii', 'pentacles-iv']);
			const challenge = readChallengeState(state)!;
			const forced = writeChallengeState(state, {
				...challenge,
				budgets: { ...challenge.budgets, 'tenure-1': { cardsThisTurn: 0, actionTaken: true, discards: null } }
			});

			const minor = applyPlayerMinorAction(forced, 'tenure-1', 'cups-ii', 'cups', playerCtx);
			expect(minor).toMatchObject({
				ok: false,
				rejection: { code: 'illegal-command', message: 'cannot perform a minor action after taking an action this turn' }
			});
		});

		it('rejects the Fool as a minor action too (same `spendCard` guard as the ordinary-action path, coordinator follow-up #1/#5)', () => {
			const { state, playerCtx } = readySoloTurn('minor-lone-fool', ['fool', 'cups-ii', 'wands-iii', 'pentacles-iv']);
			const result = applyPlayerMinorAction(state, 'tenure-1', 'fool', 'cups', playerCtx);
			expect(result).toMatchObject({
				ok: false,
				rejection: { code: 'illegal-command', message: expect.stringContaining('paired-play') }
			});
		});
	});

	describe('GM play — lesser/greater Doom predicate (O2), separate discard counter, exhausted budget', () => {
		it('tags a lesser-doom play with doomTier "lesser" and updates GM budgets', () => {
			const { state, gmCtx } = readyGmTurnFirst('gm-lesser', ['magician', 'devil']);

			const result = applyGmPlay(state, 'magician', gmCtx);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.events).toEqual([
				expect.objectContaining({
					kind: 'challenge-card-played',
					publicPayload: expect.objectContaining({ doomTier: 'lesser', valueParity: 'odd', tenureId: 'gm' })
				})
			]);
			expect(readChallengeState(result.state)).toMatchObject({
				budgets: { gm: { cardsThisTurn: 1, actionTaken: true } }
			});
			expectConserved(result.state, catalog);
		});

		it('tags a greater-doom play with doomTier "greater"', () => {
			const { state, gmCtx } = readyGmTurnFirst('gm-greater', ['devil', 'magician']);
			const result = applyGmPlay(state, 'devil', gmCtx);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.events).toEqual([
				expect.objectContaining({ kind: 'challenge-card-played', publicPayload: expect.objectContaining({ doomTier: 'greater' }) })
			]);
		});

		it('rejects a second GM play once gmPlayBudget is exhausted', () => {
			const { state, gmCtx } = readyGmTurnFirst('gm-exhausted', ['magician', 'devil']);
			const first = applyGmPlay(state, 'magician', gmCtx);
			if (!first.ok) throw first;
			const second = applyGmPlay(first.state, 'devil', gmCtx);
			expect(second).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
		});

		it('the GM is exempt from minor-action suit matching (major arcana has no suits) (O4)', () => {
			const { state, gmCtx } = readyGmTurnFirst('gm-minor-suit-exempt', ['magician', 'devil']);
			const result = applyGmMinorAction(state, 'magician', gmCtx);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.events.map((e) => e.kind)).toEqual(['challenge-minor-action-played']);
		});

		it('a discard never decrements the play budget, and tracks its own separate counter (O1 — ported from the plan)', () => {
			const { state, gmCtx } = readyGmTurnFirst('gm-discard-separate', ['magician', 'devil']);

			const discarded = applyGmDiscard(state, 'devil', gmCtx);
			expect(discarded.ok).toBe(true);
			if (!discarded.ok) return;
			expect(readChallengeState(discarded.state)).toMatchObject({
				budgets: { gm: { cardsThisTurn: 0, actionTaken: false, discards: 1 } }
			});

			const played = applyGmPlay(discarded.state, 'magician', gmCtx);
			expect(played.ok).toBe(true);
			if (!played.ok) return;
			expect(readChallengeState(played.state)).toMatchObject({
				budgets: { gm: { cardsThisTurn: 1, actionTaken: true, discards: 1 } }
			});
			expectConserved(played.state, catalog);
		});

		it('rejects a non-GM actor discarding from the GM hand', () => {
			const { state } = readyGmTurnFirst('gm-discard-not-gm', ['magician', 'devil']);
			const result = applyGmDiscard(state, 'devil', ctxFor(playerActor('tenure-1'), catalog, config, 'gm-discard-not-gm'));
			expect(result).toMatchObject({ ok: false, rejection: { code: 'not-authorized' } });
		});
	});

	describe('applyGmMulligan — elective, no numeric threshold (O3)', () => {
		it('discards the entire GM hand, redraws the same count, and consumes the once-per-round marker', () => {
			const { state, gmCtx } = readyGmTurnFirst('mulligan', ['magician', 'devil']);
			const before = readChallengeState(state)!;
			expect(before.mulliganUsedThisRound).toBe(false);

			const result = applyGmMulligan(state, gmCtx);
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			expect(result.state.gmHand).toHaveLength(2); // gmHand held exactly ['magician', 'devil'] at this point
			expect(result.state.gmHand).not.toEqual(['magician', 'devil']); // discarded and redrawn, not the same cards
			expect(readChallengeState(result.state)?.mulliganUsedThisRound).toBe(true);

			// (coordinator follow-up #4) The already-in-play Initiative card
			// ('high-priestess', placed for the ogre and already revealed into
			// the shared public Initiative zone BEFORE the mulligan) is
			// asserted DIRECTLY to still be exactly where it was — not just
			// inferred from `expectConserved`, which would still pass if it had
			// moved somewhere else legal instead of staying put.
			expect(findZoneDescriptor(result.state, CHALLENGE_INITIATIVE_ZONE_ID)?.cards).toContain('high-priestess');

			expectConserved(result.state, catalog);
		});

		it('keeps GM hand identities GM-only in the mulligan event (coordinator follow-up #3): public payload carries no card ids, only privatePayloads keyed to the GM does', () => {
			const { state, gmCtx } = readyGmTurnFirst('mulligan-privacy', ['magician', 'devil']);
			const result = applyGmMulligan(state, gmCtx);
			if (!result.ok) throw result;

			const mulliganEvent = result.events.find((event) => event.kind === 'zone-mulliganed');
			expect(mulliganEvent).toBeDefined();
			expect(mulliganEvent?.publicPayload).not.toHaveProperty('cardIds');
			expect(mulliganEvent?.publicPayload).not.toHaveProperty('discardedCardIds');
			expect(mulliganEvent?.publicPayload).not.toHaveProperty('drawnCardIds');
			expect(JSON.stringify(mulliganEvent?.publicPayload)).not.toMatch(/magician|devil|high-priestess/);

			expect(mulliganEvent?.privatePayloads).toBeDefined();
			expect(mulliganEvent?.privatePayloads?.[GM.userId]).toMatchObject({
				discardedCardIds: expect.arrayContaining(['magician', 'devil'])
			});
		});

		it('does NOT consume the once-per-round marker on a no-op mulligan against an already-empty GM hand (coordinator follow-up #5, decided: a no-op should not burn the elective)', () => {
			const { state, gmCtx } = readyGmTurnFirst('mulligan-empty', []);
			expect(state.gmHand).toEqual([]);

			const result = applyGmMulligan(state, gmCtx);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(readChallengeState(result.state)?.mulliganUsedThisRound).toBe(false);
			expectConserved(result.state, catalog);

			// The real elective is still available afterward — a later,
			// non-empty mulligan still succeeds and NOW consumes it, proving the
			// earlier no-op never spent it.
			const secondGmCtx = gmCtx;
			const withACard = forceGmHand(result.state, ['magician']);
			const secondResult = applyGmMulligan(withACard, secondGmCtx);
			expect(secondResult.ok).toBe(true);
			if (!secondResult.ok) return;
			expect(readChallengeState(secondResult.state)?.mulliganUsedThisRound).toBe(true);
			expectConserved(secondResult.state, catalog);
		});

		it('rejects a second mulligan the same round', () => {
			const { state, gmCtx } = readyGmTurnFirst('mulligan-twice', ['magician', 'devil']);
			const first = applyGmMulligan(state, gmCtx);
			if (!first.ok) throw first;
			const second = applyGmMulligan(first.state, gmCtx);
			expect(second).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
		});

		it('rejects a non-GM actor', () => {
			const { state } = readyGmTurnFirst('mulligan-not-gm', ['magician', 'devil']);
			const result = applyGmMulligan(state, ctxFor(playerActor('tenure-1'), catalog, config, 'mulligan-not-gm'));
			expect(result).toMatchObject({ ok: false, rejection: { code: 'not-authorized' } });
		});
	});

	describe('end-turn progression', () => {
		it('advances activeTurnIndex/turnKind and resets the next seat`s budget fresh', () => {
			const state = makeSessionFixture('end-turn');
			const gmCtx = ctxFor(GM, catalog, config, 'end-turn');
			const begun = beginChallenge(state, { participantTenureIds: ['tenure-1', 'tenure-2'], tenureOwners: TENURE_OWNERS, enemyFacts: [] }, gmCtx);
			if (!begun.ok) throw begun;
			const dealResult = dealRound(begun.state, gmCtx);
			if (!dealResult.ok) throw dealResult;

			// tenure-1's Initiative card ('swords-i', value 1) goes first;
			// tenure-2's ('wands-king', value 14) goes second. Each keeps a
			// SEPARATE card in hand (`cups-ii`/`cups-iii`) for the actual play,
			// distinct from the card already consumed by Initiative placement.
			const forced1 = forceHand(dealResult.state, 'tenure-1', ['swords-i', 'cups-ii', 'wands-iii', 'pentacles-iv']);
			const forced2 = forceHand(forced1, 'tenure-2', ['wands-king', 'cups-iii', 'swords-iv', 'pentacles-v']);

			const p1 = placeInitiative(forced2, 'tenure-1', 'swords-i', ctxFor(playerActor('tenure-1'), catalog, config, 'end-turn'));
			if (!p1.ok) throw p1;
			const p2 = placeInitiative(p1.state, 'tenure-2', 'wands-king', ctxFor(playerActor('tenure-2'), catalog, config, 'end-turn'));
			if (!p2.ok) throw p2;
			const revealed = revealInitiative(p2.state, gmCtx);
			if (!revealed.ok) throw revealed;
			const begunTurns = beginTurns(revealed.state, gmCtx);
			if (!begunTurns.ok) throw begunTurns;

			expect(readChallengeState(begunTurns.state)).toMatchObject({ activeTurnIndex: 0, turnKind: 'normal' });
			expect(activeTurnEntry(readChallengeState(begunTurns.state)!)?.tenureId).toBe('tenure-1');

			// tenure-1 spends their one remaining card (their Initiative card,
			// 'swords-i', was already consumed by `placeInitiative`), then ends
			// their turn.
			const played = applyPlayerAction(begunTurns.state, 'tenure-1', 'cups-ii', ctxFor(playerActor('tenure-1'), catalog, config, 'end-turn'));
			if (!played.ok) throw played;
			const ended = endTurn(played.state, ctxFor(playerActor('tenure-1'), catalog, config, 'end-turn'));
			expect(ended.ok).toBe(true);
			if (!ended.ok) return;

			const afterFirstTurn = readChallengeState(ended.state)!;
			expect(afterFirstTurn.activeTurnIndex).toBe(1);
			expect(activeTurnEntry(afterFirstTurn)?.tenureId).toBe('tenure-2');
			// tenure-2's budget is reset fresh, tenure-1's spend persists.
			expect(afterFirstTurn.budgets['tenure-2']).toMatchObject({ cardsThisTurn: 0, actionTaken: false });
			expect(afterFirstTurn.budgets['tenure-1']).toMatchObject({ cardsThisTurn: 1, actionTaken: true });

			// Ending the last seat's turn completes turns without a stage change.
			const lastEnded = endTurn(ended.state, ctxFor(playerActor('tenure-2'), catalog, config, 'end-turn'));
			expect(lastEnded.ok).toBe(true);
			if (!lastEnded.ok) return;
			const afterAll = readChallengeState(lastEnded.state)!;
			expect(afterAll.activeTurnIndex).toBeNull();
			expect(afterAll.turnKind).toBeNull();
			expect(afterAll.stage).toBe('turns');
			expectConserved(lastEnded.state, catalog);
		});

		it('rejects a player ending another tenure`s turn', () => {
			const state = makeSessionFixture('end-turn-wrong-owner');
			const gmCtx = ctxFor(GM, catalog, config, 'end-turn-wrong-owner');
			const begun = beginChallenge(state, { participantTenureIds: ['tenure-1'], tenureOwners: TENURE_OWNERS, enemyFacts: [] }, gmCtx);
			if (!begun.ok) throw begun;
			const dealResult = dealRound(begun.state, gmCtx);
			if (!dealResult.ok) throw dealResult;
			const forced = forceHand(dealResult.state, 'tenure-1', ['swords-i', 'cups-ii', 'wands-iii', 'pentacles-iv']);
			const placed = placeInitiative(forced, 'tenure-1', 'swords-i', ctxFor(playerActor('tenure-1'), catalog, config, 'end-turn-wrong-owner'));
			if (!placed.ok) throw placed;
			const revealed = revealInitiative(placed.state, gmCtx);
			if (!revealed.ok) throw revealed;
			const begunTurns = beginTurns(revealed.state, gmCtx);
			if (!begunTurns.ok) throw begunTurns;

			const result = endTurn(begunTurns.state, ctxFor({ kind: 'player', userId: 'user-bob' }, catalog, config, 'end-turn-wrong-owner'));
			expect(result).toMatchObject({ ok: false, rejection: { code: 'not-authorized' } });
		});
	});

	describe('round cleanup sweeps `played`, but a `revealed`-kind zone (Task 2\'s O7(2) gap) is deliberately left alone', () => {
		it('sweeps this task\'s new `challenge-played` zone at cleanup (already covered by Task 2\'s existing swept-kinds set — no reducer.ts change needed), while a populated `revealed`-kind zone is untouched exactly as Task 2 already leaves `inspiration`/`player-prepared`', () => {
			const { state, gmCtx, playerCtx } = readySoloTurn('cleanup-played-sweep', ['swords-vii', 'cups-ii', 'wands-iii', 'pentacles-iv']);

			const played = applyPlayerAction(state, 'tenure-1', 'swords-vii', playerCtx);
			if (!played.ok) throw played;
			expect(findZoneDescriptor(played.state, CHALLENGE_PLAYED_ZONE_ID)?.cards).toEqual(['swords-vii']);

			// Task 3 never populates a `revealed`-kind zone itself — nothing in
			// `turns.ts`/`fool.ts` creates one. Seed one anyway (pulling a real
			// card out of the draw pile to stay conserved) to prove the
			// pre-existing, deliberately-untouched gap really does survive
			// cleanup unaffected by anything this task added.
			const revealedCard = played.state.playerDraw[0];
			const seeded: SessionEngineStateV1 = {
				...played.state,
				playerDraw: played.state.playerDraw.slice(1),
				publicZones: played.state.publicZones.concat({ id: 'revealed', kind: 'revealed', cards: [revealedCard] })
			};
			expectConserved(seeded, catalog);

			const cleaned = cleanupRound(seeded, gmCtx);
			expect(cleaned.ok).toBe(true);
			if (!cleaned.ok) return;

			expect(findZoneDescriptor(cleaned.state, CHALLENGE_PLAYED_ZONE_ID)?.cards).toEqual([]);
			expect(findZoneDescriptor(cleaned.state, 'revealed')?.cards).toEqual([revealedCard]);
			expectConserved(cleaned.state, catalog);
		});
	});
});
