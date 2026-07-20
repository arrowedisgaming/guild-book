import { describe, expect, it } from 'vitest';
import { getTarotProcedures } from '$lib/server/content/loader';
import { buildChallengeConfig } from '$lib/engine/session/procedures/challenge/schema';
import type { ChallengeConfig, ChallengeEnemyFact } from '$lib/engine/session/procedures/challenge/types';
import {
	beginChallenge,
	challengeHandZoneId,
	challengeInitiativeFacedownZoneId,
	CHALLENGE_INITIATIVE_ZONE_ID,
	cleanupRound,
	readChallengeState,
	writeChallengeState,
	type ChallengeReduceContext
} from '$lib/engine/session/procedures/challenge/reducer';
import { calculateGmHandSize, dealRound } from '$lib/engine/session/procedures/challenge/deal';
import { placeInitiative, revealInitiative } from '$lib/engine/session/procedures/challenge/initiative';
import { assertSessionInvariants } from '$lib/engine/session/invariants';
import { findZoneDescriptor } from '$lib/engine/session/state';
import { projectForActor } from '$lib/engine/session/projection';
import { makeRng } from '$lib/engine/rng';
import { makeRichSessionCatalogFixture, makeSessionFixture } from '../../../fixtures/session';
import type { CardId, SessionActor, SessionEngineStateV1, SessionPlayerProjection, TarotCardCatalog } from '$lib/types/session';

const GM: SessionActor = { kind: 'gm', userId: 'gm-1' };
const TENURE_IDS = ['tenure-1', 'tenure-2', 'tenure-3', 'tenure-4'];

function playerActor(tenureId: string): SessionActor {
	return { kind: 'player', userId: tenureId };
}

function makeImpFacts(count: number): ChallengeEnemyFact[] {
	return Array.from({ length: count }, (_, i) => ({
		id: `imp-${i + 1}`,
		size: 'human',
		threat: 'minion',
		typeIds: ['imp']
	}));
}

function handCount(state: SessionEngineStateV1, tenureId: string): number {
	return findZoneDescriptor(state, challengeHandZoneId(tenureId))?.cards.length ?? 0;
}

function ctxFor(actor: SessionActor, catalog: TarotCardCatalog, config: ChallengeConfig, seed: string): ChallengeReduceContext {
	return { actor, runtime: { catalog }, rng: makeRng(seed), config };
}

/** Every configured card must exist in exactly one zone after every
 * transition (O6 — the hard invariant). */
function expectConserved(state: SessionEngineStateV1, catalog: TarotCardCatalog): void {
	expect(() => assertSessionInvariants(state, catalog)).not.toThrow();
}

describe('Challenge round — setup, dealing, initiative, cleanup', () => {
	const catalog = makeRichSessionCatalogFixture();
	const { procedures, formulas } = getTarotProcedures();
	const config = buildChallengeConfig(procedures, formulas);

	describe('calculateGmHandSize (O1 — required rulebook fixtures)', () => {
		it('12 imps vs 4 adventurers → 6 (3 base + 1 one type + 1 outnumber + 1 double)', () => {
			expect(
				calculateGmHandSize(config.gmHandFormula, { enemies: makeImpFacts(12), adventurerCount: 4 })
			).toBe(6);
		});

		it('7 imps vs 4 adventurers → 5 (3 base + 1 one type + 1 outnumber; NOT double)', () => {
			expect(
				calculateGmHandSize(config.gmHandFormula, { enemies: makeImpFacts(7), adventurerCount: 4 })
			).toBe(5);
		});

		it('counts elite/dungeon-lord presence once, not per enemy', () => {
			const enemies: ChallengeEnemyFact[] = [
				{ id: 'e1', size: 'human', threat: 'elite', typeIds: ['ogre'] },
				{ id: 'e2', size: 'human', threat: 'elite', typeIds: ['ogre'] }
			];
			// base 3 + perEnemyType 1 (one type) + eliteEnemyPresent 2 (once) = 6,
			// NOT 3 + 1 + 2 + 2 = 8.
			expect(calculateGmHandSize(config.gmHandFormula, { enemies, adventurerCount: 4 })).toBe(6);
		});

		it('floors at 0 and never goes negative', () => {
			const zeroed: ChallengeConfig['gmHandFormula'] = {
				base: 0,
				perEnemyType: 0,
				enemiesOutnumberAdventurers: 0,
				enemiesDoubleAdventurers: 0,
				perLargerThanHumanEnemy: 0,
				eliteEnemyPresent: 0,
				dungeonLordPresent: 0
			};
			expect(calculateGmHandSize(zeroed, { enemies: [], adventurerCount: 4 })).toBe(0);
		});
	});

	describe('beginChallenge', () => {
		it('starts a challenge-round procedure at stage deal, round 1', () => {
			const state = makeSessionFixture('begin');
			const result = beginChallenge(state, { participantTenureIds: TENURE_IDS, enemyFacts: makeImpFacts(12) }, ctxFor(GM, catalog, config, 'begin'));

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.state.procedure?.procedureId).toBe('challenge-round');
			const challenge = readChallengeState(result.state);
			expect(challenge).toMatchObject({ stage: 'deal', round: 1, participantTenureIds: TENURE_IDS });
			expectConserved(result.state, catalog);
		});

		it('rejects a non-GM actor', () => {
			const state = makeSessionFixture('begin-player');
			const result = beginChallenge(
				state,
				{ participantTenureIds: TENURE_IDS, enemyFacts: [] },
				ctxFor(playerActor('tenure-1'), catalog, config, 'begin-player')
			);
			expect(result).toMatchObject({ ok: false, rejection: { code: 'not-authorized' } });
		});

		it('rejects starting a second procedure while one is active', () => {
			const state = makeSessionFixture('begin-twice');
			const first = beginChallenge(state, { participantTenureIds: TENURE_IDS, enemyFacts: [] }, ctxFor(GM, catalog, config, 'begin-twice'));
			expect(first.ok).toBe(true);
			if (!first.ok) return;
			const second = beginChallenge(first.state, { participantTenureIds: TENURE_IDS, enemyFacts: [] }, ctxFor(GM, catalog, config, 'begin-twice'));
			expect(second).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
		});
	});

	describe('dealRound', () => {
		function begin(seed: string, enemyFacts: ChallengeEnemyFact[]) {
			const state = makeSessionFixture(seed);
			const gmCtx = ctxFor(GM, catalog, config, seed);
			const result = beginChallenge(state, { participantTenureIds: TENURE_IDS, enemyFacts }, gmCtx);
			if (!result.ok) throw new Error('begin failed in test setup');
			return { state: result.state, gmCtx };
		}

		it('deals the exact player and GM hand sizes and advances to initiative-placement', () => {
			const { state, gmCtx } = begin('deal', makeImpFacts(12));
			const dealt = dealRound(state, gmCtx);

			expect(dealt.ok).toBe(true);
			if (!dealt.ok) return;
			for (const tenureId of TENURE_IDS) {
				expect(handCount(dealt.state, tenureId)).toBe(config.playerBaseHandSize);
			}
			expect(dealt.state.gmHand).toHaveLength(6); // O1 fixture: 12 imps vs 4 adventurers
			expect(readChallengeState(dealt.state)?.stage).toBe('initiative-placement');
			expectConserved(dealt.state, catalog);
		});

		it('exposes only the owning player their own private hand', () => {
			const { state, gmCtx } = begin('deal-privacy', makeImpFacts(12));
			const dealt = dealRound(state, gmCtx);
			if (!dealt.ok) throw dealt;

			const playerAProjection = projectForActor(dealt.state, playerActor('tenure-1'), catalog) as SessionPlayerProjection;
			expect(playerAProjection.privateHand).toHaveLength(config.playerBaseHandSize);

			const playerACardIds = playerAProjection.privateHand.map((slot) => (slot.hidden ? null : slot.id));
			const gmProjection = projectForActor(dealt.state, GM, catalog);
			expect(gmProjection).not.toHaveProperty('privateHand');
			expect(gmProjection).not.toHaveProperty('playerHands');
			// The GM projection's public counts are fine; the actual card
			// identities must never leak into it.
			for (const cardId of playerACardIds) {
				if (cardId) expect(JSON.stringify(gmProjection)).not.toContain(cardId);
			}
		});

		it('rejects dealing outside the deal stage', () => {
			const { state, gmCtx } = begin('deal-wrong-stage', makeImpFacts(12));
			const dealt = dealRound(state, gmCtx);
			if (!dealt.ok) throw dealt;
			const secondDeal = dealRound(dealt.state, gmCtx);
			expect(secondDeal).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
		});

		it('rejects a non-GM actor', () => {
			const { state, gmCtx } = begin('deal-not-gm', makeImpFacts(12));
			const result = dealRound(state, { ...gmCtx, actor: playerActor('tenure-1') });
			expect(result).toMatchObject({ ok: false, rejection: { code: 'not-authorized' } });
		});

		it('recalculates the GM hand size fresh each round as enemies dwindle (O1)', () => {
			const { state, gmCtx } = begin('dwindle', makeImpFacts(12));
			const round1 = dealRound(state, gmCtx);
			if (!round1.ok) throw round1;
			expect(round1.state.gmHand).toHaveLength(6);

			// Place + reveal Initiative for every participant so cleanup is legal.
			let afterPlacement = round1.state;
			for (const tenureId of TENURE_IDS) {
				const hand = findZoneDescriptor(afterPlacement, challengeHandZoneId(tenureId))!;
				const placed = placeInitiative(afterPlacement, tenureId, hand.cards[0], ctxFor(playerActor(tenureId), catalog, config, 'dwindle'));
				if (!placed.ok) throw placed;
				afterPlacement = placed.state;
			}
			const revealed = revealInitiative(afterPlacement, gmCtx);
			if (!revealed.ok) throw revealed;

			const cleaned = cleanupRound(revealed.state, gmCtx, { enemyFacts: makeImpFacts(7) });
			if (!cleaned.ok) throw cleaned;
			expect(readChallengeState(cleaned.state)).toMatchObject({ stage: 'deal', round: 2 });
			expectConserved(cleaned.state, catalog);

			const round2 = dealRound(cleaned.state, ctxFor(GM, catalog, config, 'dwindle-round-2'));
			if (!round2.ok) throw round2;
			expect(round2.state.gmHand).toHaveLength(5); // O1 fixture: 7 imps vs 4 adventurers
			expectConserved(round2.state, catalog);
		});
	});

	describe('initiative placement + reveal', () => {
		function dealt(seed: string) {
			const state = makeSessionFixture(seed);
			const gmCtx = ctxFor(GM, catalog, config, seed);
			const begun = beginChallenge(state, { participantTenureIds: TENURE_IDS, enemyFacts: makeImpFacts(4) }, gmCtx);
			if (!begun.ok) throw begun;
			const dealResult = dealRound(begun.state, gmCtx);
			if (!dealResult.ok) throw dealResult;
			return { state: dealResult.state, gmCtx };
		}

		it('places a card facedown; the public projection shows an occupied card back nobody but the owner can hydrate', () => {
			const { state, gmCtx } = dealt('placement');
			const hand = findZoneDescriptor(state, challengeHandZoneId('tenure-1'))!;
			const cardId = hand.cards[0];

			const placed = placeInitiative(state, 'tenure-1', cardId, ctxFor(playerActor('tenure-1'), catalog, config, 'placement'));
			expect(placed.ok).toBe(true);
			if (!placed.ok) return;

			const publicBack = projectForActor(placed.state, GM, catalog).public.privateZoneCardBacks.find(
				(zone) => zone.ownerUserId === 'tenure-1' && zone.kind === 'player-facedown'
			);
			expect(publicBack?.cards).toEqual([{ hidden: true }]);

			// GM cannot hydrate it: the identity never appears anywhere in the GM projection.
			const gmProjection = projectForActor(placed.state, GM, catalog);
			expect(JSON.stringify(gmProjection)).not.toContain(cardId);

			// Another player cannot hydrate it either.
			const otherProjection = projectForActor(placed.state, playerActor('tenure-2'), catalog);
			expect(JSON.stringify(otherProjection)).not.toContain(cardId);

			// The owner's own projection does see it.
			const ownerProjection = projectForActor(placed.state, playerActor('tenure-1'), catalog) as SessionPlayerProjection;
			expect(ownerProjection.privateFacedown.map((slot) => (slot.hidden ? null : slot.id))).toContain(cardId);

			expectConserved(placed.state, catalog);
		});

		it('rejects a player placing Initiative for another tenure', () => {
			const { state } = dealt('placement-wrong-owner');
			const hand = findZoneDescriptor(state, challengeHandZoneId('tenure-1'))!;
			const result = placeInitiative(state, 'tenure-1', hand.cards[0], ctxFor(playerActor('tenure-2'), catalog, config, 'placement-wrong-owner'));
			expect(result).toMatchObject({ ok: false, rejection: { code: 'not-authorized' } });
		});

		it('rejects placing Initiative twice for the same tenure', () => {
			const { state } = dealt('placement-twice');
			const hand = findZoneDescriptor(state, challengeHandZoneId('tenure-1'))!;
			const playerCtx = ctxFor(playerActor('tenure-1'), catalog, config, 'placement-twice');
			const first = placeInitiative(state, 'tenure-1', hand.cards[0], playerCtx);
			if (!first.ok) throw first;
			const remainingHand = findZoneDescriptor(first.state, challengeHandZoneId('tenure-1'))!;
			const second = placeInitiative(first.state, 'tenure-1', remainingHand.cards[0], playerCtx);
			expect(second).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
		});

		it('rejects revealing before every active participant has placed', () => {
			const { state, gmCtx } = dealt('reveal-incomplete');
			const hand = findZoneDescriptor(state, challengeHandZoneId('tenure-1'))!;
			const placed = placeInitiative(state, 'tenure-1', hand.cards[0], ctxFor(playerActor('tenure-1'), catalog, config, 'reveal-incomplete'));
			if (!placed.ok) throw placed;
			const result = revealInitiative(placed.state, gmCtx);
			expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
		});

		it('reveals every placed card into the public Initiative zone, sorted ascending by value, and advances the stage', () => {
			const { state, gmCtx } = dealt('reveal');
			let working = state;
			for (const tenureId of TENURE_IDS) {
				const hand = findZoneDescriptor(working, challengeHandZoneId(tenureId))!;
				const placed = placeInitiative(working, tenureId, hand.cards[0], ctxFor(playerActor(tenureId), catalog, config, 'reveal'));
				if (!placed.ok) throw placed;
				working = placed.state;
			}

			const revealed = revealInitiative(working, gmCtx);
			expect(revealed.ok).toBe(true);
			if (!revealed.ok) return;

			const challenge = readChallengeState(revealed.state);
			expect(challenge?.stage).toBe('initiative-reveal');
			expect(challenge?.initiativeOrder).toHaveLength(TENURE_IDS.length);
			expect(challenge?.initiativeOrder.every((entry) => entry.revealed && entry.cardZoneId === CHALLENGE_INITIATIVE_ZONE_ID)).toBe(true);

			// The public initiative zone's card order must be non-decreasing by value.
			const publicZone = findZoneDescriptor(revealed.state, CHALLENGE_INITIATIVE_ZONE_ID)!;
			const values = publicZone.cards.map((cardId) => catalog[cardId]?.value ?? 0);
			for (let i = 1; i < values.length; i += 1) {
				expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
			}

			// Every private facedown zone is now empty (card conservation: moved, not cloned).
			for (const tenureId of TENURE_IDS) {
				const facedown = findZoneDescriptor(revealed.state, challengeInitiativeFacedownZoneId(tenureId))!;
				expect(facedown.cards).toHaveLength(0);
			}
			expectConserved(revealed.state, catalog);
		});

		it('breaks tied card values by stable roster order', () => {
			// Build a state directly (bypassing the random deal) with two
			// participants tied on the SAME rank across different suits.
			const state = makeSessionFixture('tie-break');
			const gmCtx = ctxFor(GM, catalog, config, 'tie-break');
			const begun = beginChallenge(state, { participantTenureIds: TENURE_IDS, enemyFacts: [] }, gmCtx);
			if (!begun.ok) throw begun;
			const dealResult = dealRound(begun.state, gmCtx);
			if (!dealResult.ok) throw dealResult;

			// Force each participant's hand to a single, known card, then place it.
			const tiedCard: Record<string, CardId> = {
				'tenure-1': 'pentacles-i', // lowest — goes first
				'tenure-2': 'cups-v', // tied with tenure-3
				'tenure-3': 'swords-v', // tied with tenure-2, but LATER in roster order
				'tenure-4': 'wands-x' // highest — goes last
			};
			let working = dealResult.state;
			for (const [tenureId, cardId] of Object.entries(tiedCard)) {
				working = withOnlyCardInZone(working, challengeHandZoneId(tenureId), cardId);
			}

			let placedState = working;
			for (const tenureId of TENURE_IDS) {
				const placed = placeInitiative(placedState, tenureId, tiedCard[tenureId], ctxFor(playerActor(tenureId), catalog, config, 'tie-break'));
				if (!placed.ok) throw placed;
				placedState = placed.state;
			}

			const revealed = revealInitiative(placedState, gmCtx);
			if (!revealed.ok) throw revealed;
			const order = readChallengeState(revealed.state)!.initiativeOrder.map((entry) => entry.tenureId);
			expect(order).toEqual(['tenure-1', 'tenure-2', 'tenure-3', 'tenure-4']);
		});
	});

	describe('cleanupRound', () => {
		function readyForCleanup(seed: string, enemyFacts: ChallengeEnemyFact[]) {
			const state = makeSessionFixture(seed);
			const gmCtx = ctxFor(GM, catalog, config, seed);
			const begun = beginChallenge(state, { participantTenureIds: TENURE_IDS, enemyFacts }, gmCtx);
			if (!begun.ok) throw begun;
			const dealResult = dealRound(begun.state, gmCtx);
			if (!dealResult.ok) throw dealResult;

			let working = dealResult.state;
			for (const tenureId of TENURE_IDS) {
				const hand = findZoneDescriptor(working, challengeHandZoneId(tenureId))!;
				const placed = placeInitiative(working, tenureId, hand.cards[0], ctxFor(playerActor(tenureId), catalog, config, seed));
				if (!placed.ok) throw placed;
				working = placed.state;
			}
			const revealed = revealInitiative(working, gmCtx);
			if (!revealed.ok) throw revealed;
			return { state: revealed.state, gmCtx };
		}

		it('discards hand and Initiative cards, increments the round, and resets per-round state', () => {
			const { state, gmCtx } = readyForCleanup('cleanup', makeImpFacts(12));
			const before = readChallengeState(state)!;

			const cleaned = cleanupRound(state, gmCtx);
			expect(cleaned.ok).toBe(true);
			if (!cleaned.ok) return;

			const after = readChallengeState(cleaned.state)!;
			expect(after.round).toBe(before.round + 1);
			expect(after.stage).toBe('deal');
			expect(after.initiativeOrder).toEqual([]);
			expect(after.mulliganUsedThisRound).toBe(false);
			expect(after.modifiers).toEqual([]);

			for (const tenureId of TENURE_IDS) {
				expect(handCount(cleaned.state, tenureId)).toBe(0);
			}
			expect(cleaned.state.gmHand).toHaveLength(0);
			const publicInitiativeZone = findZoneDescriptor(cleaned.state, CHALLENGE_INITIATIVE_ZONE_ID)!;
			expect(publicInitiativeZone.cards).toHaveLength(0);

			expectConserved(cleaned.state, catalog);
		});

		it('admits pending join tenures into the next round and provisions their zones', () => {
			const { state, gmCtx } = readyForCleanup('cleanup-join', makeImpFacts(12));
			const withPendingJoin = writeChallengeState(state, { ...readChallengeState(state)!, pendingJoinTenureIds: ['tenure-5'] });

			const cleaned = cleanupRound(withPendingJoin, gmCtx);
			expect(cleaned.ok).toBe(true);
			if (!cleaned.ok) return;

			const after = readChallengeState(cleaned.state)!;
			expect(after.participantTenureIds).toContain('tenure-5');
			expect(after.pendingJoinTenureIds).toEqual([]);
			expect(after.budgets['tenure-5']).toBeDefined();
			expect(findZoneDescriptor(cleaned.state, challengeHandZoneId('tenure-5'))).toBeDefined();
			expectConserved(cleaned.state, catalog);
		});

		it('resolves a Fool-scheduled reshuffle only at the round boundary, not immediately', () => {
			// Stack the player draw pile so the Fool is guaranteed dealt to tenure-1.
			const seed = 'cleanup-fool';
			const baseState = makeSessionFixture(seed);
			const stackedTop = ['fool', ...baseState.playerDraw.filter((id) => id !== 'fool')];
			const state = { ...baseState, playerDraw: stackedTop };
			const gmCtx = ctxFor(GM, catalog, config, seed);

			const begun = beginChallenge(state, { participantTenureIds: TENURE_IDS, enemyFacts: [] }, gmCtx);
			if (!begun.ok) throw begun;
			const dealResult = dealRound(begun.state, gmCtx);
			if (!dealResult.ok) throw dealResult;

			// Drawing the Fool schedules both decks for reshuffle, but does not
			// reshuffle immediately.
			expect(dealResult.state.reshuffleAtBoundary).toEqual({ major: true, player: true });
			const playerDrawBefore = dealResult.state.playerDraw.slice();

			let working = dealResult.state;
			for (const tenureId of TENURE_IDS) {
				const hand = findZoneDescriptor(working, challengeHandZoneId(tenureId))!;
				const placed = placeInitiative(working, tenureId, hand.cards[0], ctxFor(playerActor(tenureId), catalog, config, seed));
				if (!placed.ok) throw placed;
				working = placed.state;
			}
			const revealed = revealInitiative(working, gmCtx);
			if (!revealed.ok) throw revealed;
			expect(revealed.state.reshuffleAtBoundary).toEqual({ major: true, player: true });
			expect(revealed.state.playerDraw).toEqual(playerDrawBefore);

			const cleaned = cleanupRound(revealed.state, gmCtx);
			if (!cleaned.ok) throw cleaned;
			expect(cleaned.state.reshuffleAtBoundary).toEqual({ major: false, player: false });
			expectConserved(cleaned.state, catalog);
		});

		it('rejects a non-GM actor', () => {
			const { state, gmCtx } = readyForCleanup('cleanup-not-gm', makeImpFacts(12));
			const result = cleanupRound(state, { ...gmCtx, actor: playerActor('tenure-1') });
			expect(result).toMatchObject({ ok: false, rejection: { code: 'not-authorized' } });
		});

		it('rejects cleanup before Initiative has been revealed', () => {
			const seed = 'cleanup-too-early';
			const state = makeSessionFixture(seed);
			const gmCtx = ctxFor(GM, catalog, config, seed);
			const begun = beginChallenge(state, { participantTenureIds: TENURE_IDS, enemyFacts: [] }, gmCtx);
			if (!begun.ok) throw begun;
			const result = cleanupRound(begun.state, gmCtx);
			expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
		});
	});
});

/** Test-only helper: replaces the given zone's cards with exactly `[cardId]`,
 * conserving the total card count by returning whatever else was in that
 * zone to the matching draw pile first. */
function withOnlyCardInZone(state: SessionEngineStateV1, zoneId: string, cardId: CardId): SessionEngineStateV1 {
	const zone = findZoneDescriptor(state, zoneId);
	if (!zone) throw new Error(`withOnlyCardInZone: unknown zone ${zoneId}`);

	// Return the zone's existing cards to the player draw pile, then pull the
	// requested card out of wherever it currently lives.
	let playerDraw = state.playerDraw.concat(zone.cards);
	let majorDraw = state.majorDraw.slice();
	const gmHand = state.gmHand.filter((id) => id !== cardId);

	const privateZones = state.privateZones.map((z) => ({ ...z, cards: z.cards.filter((id) => id !== cardId) }));
	playerDraw = playerDraw.filter((id) => id !== cardId);
	majorDraw = majorDraw.filter((id) => id !== cardId);

	const withoutCard: SessionEngineStateV1 = { ...state, playerDraw, majorDraw, gmHand, privateZones };
	const targetIndex = withoutCard.privateZones.findIndex((z) => z.id === zoneId);
	const nextPrivateZones = withoutCard.privateZones.slice();
	nextPrivateZones[targetIndex] = { ...nextPrivateZones[targetIndex], cards: [cardId] };
	return { ...withoutCard, privateZones: nextPrivateZones };
}
