import { describe, expect, it } from 'vitest';
import { getTarotProcedures } from '$lib/server/content/loader';
import { buildChallengeConfig } from '$lib/engine/session/procedures/challenge/schema';
import type { ChallengeConfig, ChallengeEnemyFact } from '$lib/engine/session/procedures/challenge/types';
import {
	beginChallenge,
	challengeGmInitiativeZoneId,
	challengeHandZoneId,
	challengeInitiativeFacedownZoneId,
	CHALLENGE_INITIATIVE_ZONE_ID,
	cleanupRound,
	readChallengeState,
	writeChallengeState,
	type ChallengeReduceContext
} from '$lib/engine/session/procedures/challenge/reducer';
import { calculateGmHandSize, dealRound } from '$lib/engine/session/procedures/challenge/deal';
import { placeGmInitiative, placeInitiative, revealInitiative } from '$lib/engine/session/procedures/challenge/initiative';
import { assertSessionInvariants } from '$lib/engine/session/invariants';
import { findZoneDescriptor } from '$lib/engine/session/state';
import { projectForActor } from '$lib/engine/session/projection';
import { makeRng } from '$lib/engine/rng';
import { makeRichSessionCatalogFixture, makeSessionFixture } from '../../../fixtures/session';
import type {
	CardId,
	SessionActor,
	SessionEngineStateV1,
	SessionGmProjection,
	SessionPlayerProjection,
	TarotCardCatalog
} from '$lib/types/session';

const GM: SessionActor = { kind: 'gm', userId: 'gm-1' };
const TENURE_IDS = ['tenure-1', 'tenure-2', 'tenure-3', 'tenure-4'];

/** A tenure (Increment 1: an adventurer's attachment to a campaign
 * membership) is NEVER a user id — deliberately spelled with DISTINCT string
 * values from `TENURE_IDS` so a test that only passed because tenureId ===
 * userId (the conflation this fixture update fixes — Increment 3 Task 2
 * follow-up) cannot silently keep passing. */
const TENURE_OWNERS: Record<string, string> = {
	'tenure-1': 'user-alice',
	'tenure-2': 'user-bob',
	'tenure-3': 'user-carol',
	'tenure-4': 'user-dave'
};

function ownerOf(tenureId: string): string {
	const owner = TENURE_OWNERS[tenureId];
	if (!owner) throw new Error(`ownerOf: no owner fixture registered for ${tenureId}`);
	return owner;
}

function playerActor(tenureId: string): SessionActor {
	return { kind: 'player', userId: ownerOf(tenureId) };
}

/** ONE group entry representing `count` imps — exactly how the rulebook's
 * own worked example states it ("twelve imps facing four adventurers"): one
 * significant group, `count: 12`, not twelve separate entries. Representing
 * it as twelve separate entries was tried and found to be the coordinator-
 * identified defect this `count` field exists to prevent (see `types.ts`'s
 * `ChallengeEnemyFact` doc comment) — `enemies.length` and
 * `placeGmInitiative` must agree on what one entry means. */
function makeImpFacts(count: number): ChallengeEnemyFact[] {
	return [{ id: 'imp-swarm', size: 'human', threat: 'minion', typeIds: ['imp'], count }];
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

	/** Places Initiative for EVERY current participant tenure (from their own
	 * hand) AND every current enemy fact (from `gmHand`) — the precondition
	 * `revealInitiative` now requires for both rosters. Enemy-fact counts used
	 * across this file are deliberately kept small enough that
	 * `calculateGmHandSize`'s target always covers one card per enemy fact
	 * (the O1 12-imp/7-imp fixtures stay isolated `calculateGmHandSize` unit
	 * tests below precisely so they never have to satisfy that constraint). */
	function placeAllInitiative(state: SessionEngineStateV1, seed: string): SessionEngineStateV1 {
		const challenge = readChallengeState(state);
		if (!challenge) throw new Error('placeAllInitiative: no active Challenge round');

		let working = state;
		for (const tenureId of challenge.participantTenureIds) {
			const hand = findZoneDescriptor(working, challengeHandZoneId(tenureId))!;
			const placed = placeInitiative(working, tenureId, hand.cards[0], ctxFor(playerActor(tenureId), catalog, config, seed));
			if (!placed.ok) throw placed;
			working = placed.state;
		}
		for (const enemy of challenge.enemyFacts) {
			const cardId = working.gmHand[0];
			const placed = placeGmInitiative(working, enemy.id, cardId, ctxFor(GM, catalog, config, seed));
			if (!placed.ok) throw placed;
			working = placed.state;
		}
		return working;
	}

	describe('calculateGmHandSize (O1 — required rulebook fixtures)', () => {
		it('12 imps as ONE group entry vs 4 adventurers → 6 (3 base + 1 one type + 1 outnumber + 1 double)', () => {
			const enemies = makeImpFacts(12);
			expect(enemies).toHaveLength(1); // one group entry, not twelve — the point of `count`
			expect(calculateGmHandSize(config.gmHandFormula, { enemies, adventurerCount: 4 })).toBe(6);
		});

		it('7 imps as ONE group entry vs 4 adventurers → 5 (3 base + 1 one type + 1 outnumber; NOT double)', () => {
			const enemies = makeImpFacts(7);
			expect(enemies).toHaveLength(1);
			expect(calculateGmHandSize(config.gmHandFormula, { enemies, adventurerCount: 4 })).toBe(5);
		});

		it('weights perLargerThanHumanEnemy by count, not by entry (a group of 3 ogres scores 3x)', () => {
			const enemies: ChallengeEnemyFact[] = [
				{ id: 'ogre-trio', size: 'larger-than-human', threat: 'minion', typeIds: ['ogre'], count: 3 }
			];
			// base 3 + perEnemyType 1 (one type) + perLargerThanHumanEnemy 1 * 3 = 7.
			// totalCount=3 vs adventurerCount=4: neither outnumber (3>4 false) nor double (3>=8 false).
			expect(calculateGmHandSize(config.gmHandFormula, { enemies, adventurerCount: 4 })).toBe(7);
		});

		it('counts elite/dungeon-lord presence once, not per enemy or per count', () => {
			const enemies: ChallengeEnemyFact[] = [
				{ id: 'e1', size: 'human', threat: 'elite', typeIds: ['ogre'], count: 1 },
				{ id: 'e2', size: 'human', threat: 'elite', typeIds: ['ogre'], count: 1 }
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
			const result = beginChallenge(state, { participantTenureIds: TENURE_IDS, tenureOwners: TENURE_OWNERS, enemyFacts: makeImpFacts(12) }, ctxFor(GM, catalog, config, 'begin'));

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
				{ participantTenureIds: TENURE_IDS, tenureOwners: TENURE_OWNERS, enemyFacts: [] },
				ctxFor(playerActor('tenure-1'), catalog, config, 'begin-player')
			);
			expect(result).toMatchObject({ ok: false, rejection: { code: 'not-authorized' } });
		});

		it('rejects starting a second procedure while one is active', () => {
			const state = makeSessionFixture('begin-twice');
			const first = beginChallenge(state, { participantTenureIds: TENURE_IDS, tenureOwners: TENURE_OWNERS, enemyFacts: [] }, ctxFor(GM, catalog, config, 'begin-twice'));
			expect(first.ok).toBe(true);
			if (!first.ok) return;
			const second = beginChallenge(first.state, { participantTenureIds: TENURE_IDS, tenureOwners: TENURE_OWNERS, enemyFacts: [] }, ctxFor(GM, catalog, config, 'begin-twice'));
			expect(second).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
		});

		it('rejects an invalid enemy fact instead of throwing, and applies no partial state (Important 2)', () => {
			const state = makeSessionFixture('begin-invalid-fact');
			const invalidFacts = [{ id: 'imp-1', size: 'human', threat: 'minion', typeIds: ['imp'], count: 0 }] as ChallengeEnemyFact[];

			// Calling this directly (no try/catch) already proves it doesn't
			// throw — a `ZodError` throw would fail this test with an uncaught
			// exception rather than a normal returned rejection.
			const result = beginChallenge(state, { participantTenureIds: TENURE_IDS, tenureOwners: TENURE_OWNERS, enemyFacts: invalidFacts }, ctxFor(GM, catalog, config, 'begin-invalid-fact'));
			expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });

			// No partial state: `begin-procedure` never ran, so the input state
			// (which the caller may still hold a reference to) is still
			// pre-Challenge.
			expect(state.procedure).toBeNull();
		});

		it('rejects a whitespace-only threat/id the same way — never throws (Important 2)', () => {
			const state = makeSessionFixture('begin-whitespace-fact');
			const invalidFacts = [{ id: '   ', size: 'human', threat: 'minion', typeIds: ['imp'], count: 1 }] as ChallengeEnemyFact[];
			const result = beginChallenge(state, { participantTenureIds: TENURE_IDS, tenureOwners: TENURE_OWNERS, enemyFacts: invalidFacts }, ctxFor(GM, catalog, config, 'begin-whitespace-fact'));
			expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
			expect(state.procedure).toBeNull();
		});

		it('rejects two enemy facts sharing the same id instead of silently collapsing them (Important 3)', () => {
			const state = makeSessionFixture('begin-duplicate-fact');
			const duplicateFacts: ChallengeEnemyFact[] = [
				{ id: 'imp-swarm', size: 'human', threat: 'minion', typeIds: ['imp'], count: 1 },
				{ id: 'imp-swarm', size: 'human', threat: 'minion', typeIds: ['imp'], count: 1 }
			];
			const result = beginChallenge(state, { participantTenureIds: TENURE_IDS, tenureOwners: TENURE_OWNERS, enemyFacts: duplicateFacts }, ctxFor(GM, catalog, config, 'begin-duplicate-fact'));
			expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
			expect(state.procedure).toBeNull();
		});

		it("rejects an enemy fact id that collides with a participant tenure id (Important 3)", () => {
			const state = makeSessionFixture('begin-collision-fact');
			const collidingFacts: ChallengeEnemyFact[] = [
				{ id: 'tenure-1', size: 'human', threat: 'minion', typeIds: ['imp'], count: 1 }
			];
			const result = beginChallenge(state, { participantTenureIds: TENURE_IDS, tenureOwners: TENURE_OWNERS, enemyFacts: collidingFacts }, ctxFor(GM, catalog, config, 'begin-collision-fact'));
			expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
			expect(state.procedure).toBeNull();
		});

		it('rejects a roster with a tenure that has no registered owner (tenureId-vs-userId fix)', () => {
			const state = makeSessionFixture('begin-missing-owner');
			const incompleteOwners = { ...TENURE_OWNERS };
			delete incompleteOwners['tenure-2'];

			const result = beginChallenge(
				state,
				{ participantTenureIds: TENURE_IDS, tenureOwners: incompleteOwners, enemyFacts: [] },
				ctxFor(GM, catalog, config, 'begin-missing-owner')
			);
			expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
			expect(state.procedure).toBeNull();
		});
	});

	describe('tenure ownership — a tenure id is NOT a user id (Increment 3 Task 2 follow-up)', () => {
		// A tenure is an adventurer's attachment to a campaign membership
		// (Increment 1), not a user id. Before this fix, zone ownership and
		// Initiative-placement authorization both compared directly against
		// the tenure id, which only worked because every fixture happened to
		// pass the same string as both. `TENURE_OWNERS` (file header) uses
		// visibly distinct tenure/user id spaces specifically so these tests
		// cannot pass by accident the way the old ones could.
		function dealtWithOwners(seed: string) {
			const state = makeSessionFixture(seed);
			const gmCtx = ctxFor(GM, catalog, config, seed);
			const begun = beginChallenge(state, { participantTenureIds: TENURE_IDS, tenureOwners: TENURE_OWNERS, enemyFacts: [] }, gmCtx);
			if (!begun.ok) throw begun;
			const dealResult = dealRound(begun.state, gmCtx);
			if (!dealResult.ok) throw dealResult;
			return { state: dealResult.state, gmCtx };
		}

		it("a hand zone's ownerUserId is the owning USER, not the tenure id", () => {
			const { state } = dealtWithOwners('owner-hand-zone');
			const handZone = findZoneDescriptor(state, challengeHandZoneId('tenure-1'));
			expect(handZone?.owner).toEqual({ kind: 'player', userId: ownerOf('tenure-1') });
			expect(handZone?.owner).not.toEqual({ kind: 'player', userId: 'tenure-1' });
		});

		it('the owning user can see their own hand and place their own Initiative', () => {
			const { state } = dealtWithOwners('owner-can-place');
			const owningActor: SessionActor = { kind: 'player', userId: ownerOf('tenure-1') };

			const projection = projectForActor(state, owningActor, catalog) as SessionPlayerProjection;
			expect(projection.privateHand.length).toBeGreaterThan(0);

			const hand = findZoneDescriptor(state, challengeHandZoneId('tenure-1'))!;
			const placed = placeInitiative(state, 'tenure-1', hand.cards[0], ctxFor(owningActor, catalog, config, 'owner-can-place'));
			expect(placed.ok).toBe(true);
		});

		it('a DIFFERENT owning user cannot place Initiative for a tenure they do not own, even knowing its tenure id', () => {
			const { state } = dealtWithOwners('owner-cannot-place');
			const hand = findZoneDescriptor(state, challengeHandZoneId('tenure-1'))!;
			const otherOwningActor: SessionActor = { kind: 'player', userId: ownerOf('tenure-2') };

			const result = placeInitiative(state, 'tenure-1', hand.cards[0], ctxFor(otherOwningActor, catalog, config, 'owner-cannot-place'));
			expect(result).toMatchObject({ ok: false, rejection: { code: 'not-authorized' } });
		});
	});

	describe('dealRound', () => {
		function begin(seed: string, enemyFacts: ChallengeEnemyFact[]) {
			const state = makeSessionFixture(seed);
			const gmCtx = ctxFor(GM, catalog, config, seed);
			const result = beginChallenge(state, { participantTenureIds: TENURE_IDS, tenureOwners: TENURE_OWNERS, enemyFacts }, gmCtx);
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

		it('recalculates the GM hand size fresh each round as the imp group dwindles (O1, full pipeline)', () => {
			// The book's own worked example, now representable exactly as it's
			// stated ("twelve imps facing four adventurers" / "the adventurers
			// reduce the number of imps to seven"): ONE group entry per round,
			// not one entry per creature. This is the assertion that proves
			// `calculateGmHandSize` (headcount via `count`) and
			// `placeGmInitiative` (one card per entry) finally agree on what an
			// `enemyFacts` entry means — round 1 needs exactly one GM Initiative
			// placement for twelve imps, and round 2 needs exactly one for seven.
			const round1Enemies = makeImpFacts(12);
			expect(round1Enemies).toHaveLength(1);

			const { state, gmCtx } = begin('dwindle', round1Enemies);
			const round1 = dealRound(state, gmCtx);
			if (!round1.ok) throw round1;
			expect(round1.state.gmHand).toHaveLength(6); // O1 fixture

			const placed = placeAllInitiative(round1.state, 'dwindle');
			// Exactly one GM Initiative card was placed for the whole imp group:
			// gmHand lost exactly one card, not twelve.
			expect(placed.gmHand).toHaveLength(round1.state.gmHand.length - 1);
			const revealed = revealInitiative(placed, gmCtx);
			if (!revealed.ok) throw revealed;
			expect(readChallengeState(revealed.state)?.initiativeOrder.filter((e) => e.tenureId === 'imp-swarm')).toHaveLength(1);

			const round2Enemies = makeImpFacts(7);
			expect(round2Enemies).toHaveLength(1);
			const cleaned = cleanupRound(revealed.state, gmCtx, { enemyFacts: round2Enemies });
			if (!cleaned.ok) throw cleaned;
			expect(readChallengeState(cleaned.state)).toMatchObject({ stage: 'deal', round: 2 });
			expectConserved(cleaned.state, catalog);

			const round2 = dealRound(cleaned.state, ctxFor(GM, catalog, config, 'dwindle-round-2'));
			if (!round2.ok) throw round2;
			expect(round2.state.gmHand).toHaveLength(5); // O1 fixture

			const placed2 = placeAllInitiative(round2.state, 'dwindle-round-2');
			expect(placed2.gmHand).toHaveLength(round2.state.gmHand.length - 1); // still exactly one card
			expectConserved(placed2, catalog);
		});
	});

	describe('initiative placement + reveal', () => {
		function dealt(seed: string, enemyFacts: ChallengeEnemyFact[] = makeImpFacts(4)) {
			const state = makeSessionFixture(seed);
			const gmCtx = ctxFor(GM, catalog, config, seed);
			const begun = beginChallenge(state, { participantTenureIds: TENURE_IDS, tenureOwners: TENURE_OWNERS, enemyFacts }, gmCtx);
			if (!begun.ok) throw begun;
			const dealResult = dealRound(begun.state, gmCtx);
			if (!dealResult.ok) throw dealResult;
			return { state: dealResult.state, gmCtx };
		}

		it('places a card facedown; the public projection shows an occupied card back nobody but the owner can hydrate', () => {
			const { state } = dealt('placement');
			const hand = findZoneDescriptor(state, challengeHandZoneId('tenure-1'))!;
			const cardId = hand.cards[0];

			const placed = placeInitiative(state, 'tenure-1', cardId, ctxFor(playerActor('tenure-1'), catalog, config, 'placement'));
			expect(placed.ok).toBe(true);
			if (!placed.ok) return;

			const publicBack = projectForActor(placed.state, GM, catalog).public.privateZoneCardBacks.find(
				(zone) => zone.ownerUserId === ownerOf('tenure-1') && zone.kind === 'player-facedown'
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

		it('rejects revealing before every active participant (and every enemy fact) has placed', () => {
			const { state, gmCtx } = dealt('reveal-incomplete');
			const hand = findZoneDescriptor(state, challengeHandZoneId('tenure-1'))!;
			const placed = placeInitiative(state, 'tenure-1', hand.cards[0], ctxFor(playerActor('tenure-1'), catalog, config, 'reveal-incomplete'));
			if (!placed.ok) throw placed;
			const result = revealInitiative(placed.state, gmCtx);
			expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
		});

		it('reveals every placed card (players AND GM enemy groups) into the public Initiative zone, sorted ascending by value, and advances the stage', () => {
			const enemyFacts = makeImpFacts(4);
			const { state, gmCtx } = dealt('reveal', enemyFacts);
			const working = placeAllInitiative(state, 'reveal');

			const revealed = revealInitiative(working, gmCtx);
			expect(revealed.ok).toBe(true);
			if (!revealed.ok) return;

			const challenge = readChallengeState(revealed.state);
			expect(challenge?.stage).toBe('initiative-reveal');
			expect(challenge?.initiativeOrder).toHaveLength(TENURE_IDS.length + enemyFacts.length);
			expect(challenge?.initiativeOrder.every((entry) => entry.revealed && entry.cardZoneId === CHALLENGE_INITIATIVE_ZONE_ID)).toBe(true);
			// Every enemy fact's id shows up somewhere in the revealed order.
			for (const enemy of enemyFacts) {
				expect(challenge?.initiativeOrder.some((entry) => entry.tenureId === enemy.id)).toBe(true);
			}

			// The public initiative zone's card order must be non-decreasing by value.
			const publicZone = findZoneDescriptor(revealed.state, CHALLENGE_INITIATIVE_ZONE_ID)!;
			const values = publicZone.cards.map((cardId) => catalog[cardId]?.value ?? 0);
			for (let i = 1; i < values.length; i += 1) {
				expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
			}

			// Every private/pending facedown zone is now empty (card
			// conservation: moved, not cloned) — both player and GM rosters.
			for (const tenureId of TENURE_IDS) {
				const facedown = findZoneDescriptor(revealed.state, challengeInitiativeFacedownZoneId(tenureId))!;
				expect(facedown.cards).toHaveLength(0);
			}
			for (const enemy of enemyFacts) {
				const facedown = findZoneDescriptor(revealed.state, challengeGmInitiativeZoneId(enemy.id))!;
				expect(facedown.cards).toHaveLength(0);
			}
			expectConserved(revealed.state, catalog);
		});

		it('breaks tied card values by a stable default roster order, but surfaces the tie for the table to adjudicate rather than presenting it as resolved', () => {
			// Build a state directly (bypassing the random deal) with two
			// participants tied on the SAME rank across different suits.
			const state = makeSessionFixture('tie-break');
			const gmCtx = ctxFor(GM, catalog, config, 'tie-break');
			const begun = beginChallenge(state, { participantTenureIds: TENURE_IDS, tenureOwners: TENURE_OWNERS, enemyFacts: [] }, gmCtx);
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

			// A stable, deterministic default order still exists in state —
			// Task 3's turn loop needs something concrete to iterate — but it
			// is a default, not a proclaimed ruling.
			const order = readChallengeState(revealed.state)!.initiativeOrder.map((entry) => entry.tenureId);
			expect(order).toEqual(['tenure-1', 'tenure-2', 'tenure-3', 'tenure-4']);

			// The tie itself is surfaced publicly so the table can adjudicate
			// it themselves (Ch7 "Tied Initiative": a table decision, not an
			// engine ruling), not silently absorbed into that default order.
			const revealEvent = revealed.events.find((event) => event.kind === 'challenge-initiative-revealed');
			expect(revealEvent?.publicPayload).toMatchObject({ tiedGroups: [['tenure-2', 'tenure-3']] });

			// (M1) The tie is durable in STATE too, not only on this momentary
			// event — Task 3's turn loop and Task 6's UI read state, not the
			// event log. Re-parse via `readChallengeState` (a fresh
			// `challengeStateV1Schema.safeParse` off `state.procedure.gmPrivate`)
			// to prove it survives a real write/read round-trip, not just
			// in-memory object identity.
			expect(readChallengeState(revealed.state)?.tiedGroups).toEqual([['tenure-2', 'tenure-3']]);
		});
	});

	describe('GM Initiative (enemy groups)', () => {
		function dealtWithEnemies(seed: string, enemyFacts: ChallengeEnemyFact[]) {
			const state = makeSessionFixture(seed);
			const gmCtx = ctxFor(GM, catalog, config, seed);
			const begun = beginChallenge(state, { participantTenureIds: TENURE_IDS, tenureOwners: TENURE_OWNERS, enemyFacts }, gmCtx);
			if (!begun.ok) throw begun;
			const dealResult = dealRound(begun.state, gmCtx);
			if (!dealResult.ok) throw dealResult;
			return { state: dealResult.state, gmCtx };
		}

		const oneOgre: ChallengeEnemyFact[] = [{ id: 'ogre-1', size: 'human', threat: 'minion', typeIds: ['ogre'], count: 1 }];

		it('places one card per enemy fact from gmHand into a GM-only pending zone', () => {
			const { state, gmCtx } = dealtWithEnemies('gm-initiative-place', oneOgre);
			const cardId = state.gmHand[0];

			const placed = placeGmInitiative(state, 'ogre-1', cardId, gmCtx);
			expect(placed.ok).toBe(true);
			if (!placed.ok) return;

			expect(placed.state.gmHand).not.toContain(cardId);
			const pendingZone = findZoneDescriptor(placed.state, challengeGmInitiativeZoneId('ogre-1'));
			expect(pendingZone?.cards).toEqual([cardId]);
			expect(readChallengeState(placed.state)?.initiativeOrder).toContainEqual({
				tenureId: 'ogre-1',
				cardZoneId: challengeGmInitiativeZoneId('ogre-1'),
				revealed: false
			});
			expectConserved(placed.state, catalog);
		});

		it('is publicly visible only as an occupied-but-hidden pending-zone count to players; the GM who placed it can see it themselves', () => {
			const { state, gmCtx } = dealtWithEnemies('gm-initiative-privacy', oneOgre);
			const cardId = state.gmHand[0];
			const placed = placeGmInitiative(state, 'ogre-1', cardId, gmCtx);
			if (!placed.ok) throw placed;

			const pendingCount = projectForActor(placed.state, playerActor('tenure-1'), catalog).public.pendingZoneCounts.find(
				(zone) => zone.id === challengeGmInitiativeZoneId('ogre-1')
			);
			expect(pendingCount).toMatchObject({ deck: 'major', count: 1 });

			// Neither player can hydrate the GM's placed enemy Initiative card.
			for (const actor of [playerActor('tenure-1'), playerActor('tenure-2')]) {
				const projection = projectForActor(placed.state, actor, catalog);
				expect(JSON.stringify(projection)).not.toContain(cardId);
			}

			// "GM-private" means private TO the GM, not hidden from the GM too:
			// the GM who placed this card can see which card it was via the new
			// GM-only pending-zone hydration.
			const gmProjection = projectForActor(placed.state, GM, catalog) as SessionGmProjection;
			expect(JSON.stringify(gmProjection)).toContain(cardId);
			const gmPendingZone = gmProjection.gmPendingZones.find((zone) => zone.id === challengeGmInitiativeZoneId('ogre-1'));
			expect(gmPendingZone?.deck).toBe('major');
			expect(gmPendingZone?.cards.map((slot) => (slot.hidden ? null : slot.id))).toEqual([cardId]);
			expectConserved(placed.state, catalog);
		});

		it('rejects a non-GM actor', () => {
			const { state } = dealtWithEnemies('gm-initiative-not-gm', oneOgre);
			const result = placeGmInitiative(state, 'ogre-1', state.gmHand[0], ctxFor(playerActor('tenure-1'), catalog, config, 'gm-initiative-not-gm'));
			expect(result).toMatchObject({ ok: false, rejection: { code: 'not-authorized' } });
		});

		it('rejects an enemy fact id that is not part of the current round', () => {
			const { state, gmCtx } = dealtWithEnemies('gm-initiative-unknown', oneOgre);
			const result = placeGmInitiative(state, 'not-a-real-enemy', state.gmHand[0], gmCtx);
			expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
		});

		it('rejects placing Initiative twice for the same enemy fact', () => {
			const { state, gmCtx } = dealtWithEnemies('gm-initiative-twice', oneOgre);
			const first = placeGmInitiative(state, 'ogre-1', state.gmHand[0], gmCtx);
			if (!first.ok) throw first;
			const second = placeGmInitiative(first.state, 'ogre-1', first.state.gmHand[0], gmCtx);
			expect(second).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
		});

		it('appears in the revealed public Initiative order alongside player Initiative', () => {
			const { state, gmCtx } = dealtWithEnemies('gm-initiative-reveal', oneOgre);
			const cardId = state.gmHand[0];
			const gmPlaced = placeGmInitiative(state, 'ogre-1', cardId, gmCtx);
			if (!gmPlaced.ok) throw gmPlaced;

			let working = gmPlaced.state;
			for (const tenureId of TENURE_IDS) {
				const hand = findZoneDescriptor(working, challengeHandZoneId(tenureId))!;
				const placed = placeInitiative(working, tenureId, hand.cards[0], ctxFor(playerActor(tenureId), catalog, config, 'gm-initiative-reveal'));
				if (!placed.ok) throw placed;
				working = placed.state;
			}

			const revealed = revealInitiative(working, gmCtx);
			expect(revealed.ok).toBe(true);
			if (!revealed.ok) return;

			const challenge = readChallengeState(revealed.state);
			const ogreEntry = challenge?.initiativeOrder.find((entry) => entry.tenureId === 'ogre-1');
			expect(ogreEntry).toMatchObject({ revealed: true, cardZoneId: CHALLENGE_INITIATIVE_ZONE_ID });

			const publicZone = findZoneDescriptor(revealed.state, CHALLENGE_INITIATIVE_ZONE_ID)!;
			expect(publicZone.cards).toContain(cardId);

			// Gone from gmHand and from the pending zone — moved, not cloned.
			expect(revealed.state.gmHand).not.toContain(cardId);
			expect(findZoneDescriptor(revealed.state, challengeGmInitiativeZoneId('ogre-1'))?.cards).toHaveLength(0);

			expectConserved(revealed.state, catalog);
		});
	});

	describe('cleanupRound', () => {
		// Small, non-O1 enemy counts: cleanup tests exercise the boundary
		// mechanics, not the hand-formula's exact numbers (covered above), and
		// now every enemy fact needs its own GM Initiative placement before a
		// reveal can precede cleanup.
		function readyForCleanup(seed: string, enemyFacts: ChallengeEnemyFact[]) {
			const state = makeSessionFixture(seed);
			const gmCtx = ctxFor(GM, catalog, config, seed);
			const begun = beginChallenge(state, { participantTenureIds: TENURE_IDS, tenureOwners: TENURE_OWNERS, enemyFacts }, gmCtx);
			if (!begun.ok) throw begun;
			const dealResult = dealRound(begun.state, gmCtx);
			if (!dealResult.ok) throw dealResult;

			const working = placeAllInitiative(dealResult.state, seed);
			const revealed = revealInitiative(working, gmCtx);
			if (!revealed.ok) throw revealed;
			return { state: revealed.state, gmCtx };
		}

		it('discards hand and Initiative cards, increments the round, and resets per-round state', () => {
			const { state, gmCtx } = readyForCleanup('cleanup', makeImpFacts(2));
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

		it('leaves inspiration and prepared zones untouched at cleanup while hands/Initiative ARE discarded (M2 — the O6 untouched-zone clause)', () => {
			const { state, gmCtx } = readyForCleanup('cleanup-untouched', makeImpFacts(2));

			// Seed a populated public `inspiration` zone and a private
			// `player-prepared` zone by pulling two real cards out of the
			// player draw pile, so the fixture's card count stays conserved.
			const inspirationCard = state.playerDraw[0];
			const preparedCard = state.playerDraw[1];
			if (!inspirationCard || !preparedCard) throw new Error('fixture empty');

			const seeded: SessionEngineStateV1 = {
				...state,
				playerDraw: state.playerDraw.slice(2),
				publicZones: state.publicZones.concat({ id: 'inspiration', kind: 'inspiration', cards: [inspirationCard] }),
				privateZones: state.privateZones.concat({
					id: 'prepared:tenure-1',
					kind: 'player-prepared',
					ownerUserId: 'tenure-1',
					cards: [preparedCard]
				})
			};
			expectConserved(seeded, catalog);

			const cleaned = cleanupRound(seeded, gmCtx);
			expect(cleaned.ok).toBe(true);
			if (!cleaned.ok) return;

			// Untouched: contents survive intact.
			expect(findZoneDescriptor(cleaned.state, 'inspiration')?.cards).toEqual([inspirationCard]);
			expect(findZoneDescriptor(cleaned.state, 'prepared:tenure-1')?.cards).toEqual([preparedCard]);

			// Meanwhile hands (and the public Initiative zone) ARE swept.
			for (const tenureId of TENURE_IDS) {
				expect(handCount(cleaned.state, tenureId)).toBe(0);
			}
			expect(cleaned.state.gmHand).toHaveLength(0);
			expect(findZoneDescriptor(cleaned.state, CHALLENGE_INITIATIVE_ZONE_ID)?.cards).toHaveLength(0);

			expectConserved(cleaned.state, catalog);
		});

		it('admits pending join tenures into the next round and provisions their zones, owned by their real user (not the tenure id)', () => {
			const { state, gmCtx } = readyForCleanup('cleanup-join', makeImpFacts(2));
			const withPendingJoin = writeChallengeState(state, { ...readChallengeState(state)!, pendingJoinTenureIds: ['tenure-5'] });

			// The new tenure's owner isn't registered yet — supplied at the same
			// moment it's admitted, exactly the scenario `CleanupRoundOptions.
			// tenureOwners` exists for.
			const cleaned = cleanupRound(withPendingJoin, gmCtx, { tenureOwners: { 'tenure-5': 'user-eve' } });
			expect(cleaned.ok).toBe(true);
			if (!cleaned.ok) return;

			const after = readChallengeState(cleaned.state)!;
			expect(after.participantTenureIds).toContain('tenure-5');
			expect(after.pendingJoinTenureIds).toEqual([]);
			expect(after.budgets['tenure-5']).toBeDefined();
			expect(after.tenureOwners['tenure-5']).toBe('user-eve');
			const handZone = findZoneDescriptor(cleaned.state, challengeHandZoneId('tenure-5'));
			expect(handZone).toBeDefined();
			expect(handZone?.owner).toEqual({ kind: 'player', userId: 'user-eve' });
			expectConserved(cleaned.state, catalog);
		});

		it('rejects admitting a pending join tenure with no registered owner', () => {
			const { state, gmCtx } = readyForCleanup('cleanup-join-no-owner', makeImpFacts(2));
			const withPendingJoin = writeChallengeState(state, { ...readChallengeState(state)!, pendingJoinTenureIds: ['tenure-5'] });

			const result = cleanupRound(withPendingJoin, gmCtx);
			expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
		});

		it('resolves a Fool-scheduled reshuffle only at the round boundary, not immediately', () => {
			// Stack the player draw pile so the Fool is guaranteed dealt to tenure-1.
			const seed = 'cleanup-fool';
			const baseState = makeSessionFixture(seed);
			const stackedTop = ['fool', ...baseState.playerDraw.filter((id) => id !== 'fool')];
			const state = { ...baseState, playerDraw: stackedTop };
			const gmCtx = ctxFor(GM, catalog, config, seed);

			const begun = beginChallenge(state, { participantTenureIds: TENURE_IDS, tenureOwners: TENURE_OWNERS, enemyFacts: [] }, gmCtx);
			if (!begun.ok) throw begun;
			const dealResult = dealRound(begun.state, gmCtx);
			if (!dealResult.ok) throw dealResult;

			// Drawing the Fool schedules both decks for reshuffle, but does not
			// reshuffle immediately.
			expect(dealResult.state.reshuffleAtBoundary).toEqual({ major: true, player: true });
			const playerDrawBefore = dealResult.state.playerDraw.slice();

			const working = placeAllInitiative(dealResult.state, seed);
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
			const { state, gmCtx } = readyForCleanup('cleanup-not-gm', makeImpFacts(2));
			const result = cleanupRound(state, { ...gmCtx, actor: playerActor('tenure-1') });
			expect(result).toMatchObject({ ok: false, rejection: { code: 'not-authorized' } });
		});

		it('rejects cleanup before Initiative has been revealed', () => {
			const seed = 'cleanup-too-early';
			const state = makeSessionFixture(seed);
			const gmCtx = ctxFor(GM, catalog, config, seed);
			const begun = beginChallenge(state, { participantTenureIds: TENURE_IDS, tenureOwners: TENURE_OWNERS, enemyFacts: [] }, gmCtx);
			if (!begun.ok) throw begun;
			const result = cleanupRound(begun.state, gmCtx);
			expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
		});

		it('rejects an invalid next-round enemy fact instead of throwing, and applies no partial state (Important 2)', () => {
			const { state, gmCtx } = readyForCleanup('cleanup-invalid-fact', makeImpFacts(2));
			const before = readChallengeState(state)!;
			const invalidNextFacts = [{ id: 'imp-1', size: 'human', threat: 'minion', typeIds: ['imp'], count: 0 }] as ChallengeEnemyFact[];

			// No try/catch: a thrown ZodError would fail this test directly.
			const result = cleanupRound(state, gmCtx, { enemyFacts: invalidNextFacts });
			expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });

			// No partial state: the sweep never ran, so hands are exactly what
			// they were pre-cleanup (non-empty), and `readChallengeState` off the
			// same input `state` still shows the pre-cleanup round/stage.
			for (const tenureId of TENURE_IDS) {
				expect(handCount(state, tenureId)).toBeGreaterThan(0);
			}
			expect(readChallengeState(state)).toMatchObject({ round: before.round, stage: before.stage });
		});

		it('rejects two next-round enemy facts sharing the same id instead of silently collapsing them (Important 3)', () => {
			const { state, gmCtx } = readyForCleanup('cleanup-duplicate-fact', makeImpFacts(2));
			const duplicateNextFacts: ChallengeEnemyFact[] = [
				{ id: 'imp-swarm', size: 'human', threat: 'minion', typeIds: ['imp'], count: 1 },
				{ id: 'imp-swarm', size: 'human', threat: 'minion', typeIds: ['imp'], count: 1 }
			];
			const result = cleanupRound(state, gmCtx, { enemyFacts: duplicateNextFacts });
			expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
			for (const tenureId of TENURE_IDS) {
				expect(handCount(state, tenureId)).toBeGreaterThan(0);
			}
		});

		it('rejects a next-round enemy fact id that collides with a (possibly newly-admitted) participant tenure id (Important 3)', () => {
			const { state, gmCtx } = readyForCleanup('cleanup-collision-fact', makeImpFacts(2));
			const withPendingJoin = writeChallengeState(state, { ...readChallengeState(state)!, pendingJoinTenureIds: ['tenure-5'] });
			const collidingNextFacts: ChallengeEnemyFact[] = [
				{ id: 'tenure-5', size: 'human', threat: 'minion', typeIds: ['imp'], count: 1 }
			];
			// Owner supplied so this rejection is proven to come from the
			// enemy/tenure collision guard specifically, not incidentally from
			// tenure-5 lacking a registered owner (a separate, already-tested
			// rejection path).
			const result = cleanupRound(withPendingJoin, gmCtx, {
				enemyFacts: collidingNextFacts,
				tenureOwners: { 'tenure-5': 'user-eve' }
			});
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
