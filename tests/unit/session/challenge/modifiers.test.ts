import { describe, expect, it } from 'vitest';
import { getTarotProcedures } from '$lib/server/content/loader';
import { buildChallengeConfig } from '$lib/engine/session/procedures/challenge/schema';
import type { ChallengeConfig, ChallengeEnemyFact } from '$lib/engine/session/procedures/challenge/types';
import {
	beginChallenge,
	challengeAimZoneId,
	challengeGuardianAngelStagingZoneId,
	challengeGuardianAngelZoneId,
	challengeHandZoneId,
	challengeInitiativeFacedownZoneId,
	CHALLENGE_INITIATIVE_ZONE_ID,
	cleanupRound,
	readChallengeState,
	writeChallengeState,
	type ChallengeReduceContext
} from '$lib/engine/session/procedures/challenge/reducer';
import { dealRound } from '$lib/engine/session/procedures/challenge/deal';
import { placeInitiative, revealInitiative } from '$lib/engine/session/procedures/challenge/initiative';
import { beginTurns, endTurn } from '$lib/engine/session/procedures/challenge/turns';
import { playFool } from '$lib/engine/session/procedures/challenge/fool';
import {
	applyBlackHoney,
	applyBrainfever,
	applyChallengeModifierCommand,
	applyGuard,
	applyGuardianAngel,
	applyStun,
	findModifierParams,
	legalChallengeModifierCommands,
	prepareAim,
	resolveAim,
	resolveGuardianAngel,
	resolveStun,
	CHALLENGE_AIM_ID,
	CHALLENGE_BLACK_HONEY_ID,
	CHALLENGE_BRAINFEVER_ID,
	CHALLENGE_GUARD_ID,
	CHALLENGE_GUARDIAN_ANGEL_ID,
	CHALLENGE_STUN_ID,
	type ChallengeModifierMaterials
} from '$lib/engine/session/procedures/challenge/modifiers';
import { CHALLENGE_COUNSEL_ID } from '$lib/engine/session/procedures/challenge/transfers';
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
import type {
	CounselTransferParams,
	ForcedHandDiscardParams,
	ForcedInitiativeSelectionParams,
	GuardianAngelParams,
	OptionalHandSizeParams,
	PreparedFacedownBonusParams,
	ReplaceInitiativeParams
} from '$lib/types/content-pack';

const GM: SessionActor = { kind: 'gm', userId: 'gm-1' };

/** Distinct string space from user ids (O7 — never conflate tenure/user). */
const TENURE_OWNERS: Record<string, string> = {
	'tenure-1': 'user-alice',
	'tenure-2': 'user-bob'
};

function playerActor(tenureId: string): SessionActor {
	const owner = TENURE_OWNERS[tenureId];
	if (!owner) throw new Error(`no owner fixture registered for ${tenureId}`);
	return { kind: 'player', userId: owner };
}

function ctxFor(actor: SessionActor, catalog: TarotCardCatalog, config: ChallengeConfig, seed: string): ChallengeReduceContext {
	return { actor, runtime: { catalog }, rng: makeRng(seed), config };
}

function expectConserved(state: SessionEngineStateV1, catalog: TarotCardCatalog): void {
	expect(() => assertSessionInvariants(state, catalog)).not.toThrow();
}

/** Replaces `tenureId`'s ENTIRE hand with exactly `cardIds`, mirroring
 * `turns.test.ts`'s helper of the same shape (duplicated rather than
 * imported — test files don't share fixtures with each other, only with
 * `tests/fixtures/session.ts`). */
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

describe('Challenge modifiers (Increment 3 Task 4)', () => {
	const catalog = makeRichSessionCatalogFixture();
	const { procedures, formulas, modifiers } = getTarotProcedures();
	const config = buildChallengeConfig(procedures, formulas);

	const blackHoneyParams = findModifierParams<OptionalHandSizeParams>(modifiers, CHALLENGE_BLACK_HONEY_ID, 'optional-hand-size');
	const stunParams = findModifierParams<ForcedHandDiscardParams>(modifiers, CHALLENGE_STUN_ID, 'forced-hand-discard');
	const brainfeverParams = findModifierParams<ForcedInitiativeSelectionParams>(
		modifiers,
		CHALLENGE_BRAINFEVER_ID,
		'forced-initiative-selection'
	);
	const guardianAngelParams = findModifierParams<GuardianAngelParams>(modifiers, CHALLENGE_GUARDIAN_ANGEL_ID, 'guardian-angel-defense');
	const aimParams = findModifierParams<PreparedFacedownBonusParams>(modifiers, CHALLENGE_AIM_ID, 'prepared-facedown-bonus');
	const guardParams = findModifierParams<ReplaceInitiativeParams>(modifiers, CHALLENGE_GUARD_ID, 'replace-initiative');
	const counselParams = findModifierParams<CounselTransferParams>(modifiers, CHALLENGE_COUNSEL_ID, 'private-transfer');

	/** Every params block `applyChallengeModifierCommand` needs, assembled
	 * once — mirrors how a real caller would build this once per session/
	 * content-load. */
	const materials: ChallengeModifierMaterials = {
		blackHoney: blackHoneyParams,
		stun: stunParams,
		brainfever: brainfeverParams,
		counsel: counselParams,
		guardianAngel: guardianAngelParams,
		aim: aimParams,
		guard: guardParams,
		hasShield: true,
		hasBow: true
	};

	/** The smaller cap bundle `legalChallengeModifierCommands` itself takes —
	 * deliberately a DIFFERENT (narrower) shape than `materials` above, so a
	 * test calling the derivation function directly must supply exactly what
	 * it needs, not the whole materials bag (`applyChallengeModifierCommand`
	 * builds this same shape internally from `materials`). */
	const derivationCaps = {
		counselMaxUsesPerRound: counselParams.maxUsesPerRound,
		guardianAngelMaxInstances: guardianAngelParams.maxInstances,
		hasBow: true,
		hasShield: true
	};

	it('every modifier lookup narrows to its expected params shape (content-integrity guard)', () => {
		expect(blackHoneyParams).toEqual({ normalCards: 4, optionalCards: 5, teethLostFrom: 1, teethLostTo: 4 });
		expect(stunParams).toEqual({ immediate: true, discard: 'one-card', playerChooses: true });
		expect(guardParams).toEqual({ requiresShield: true, anySuit: true, actionBudget: 'miscellaneous', discardsOldInitiative: true });
	});

	it('findModifierParams throws (content-integrity bug, not a rejectable user error) on a behaviorId mismatch', () => {
		expect(() => findModifierParams(modifiers, CHALLENGE_BLACK_HONEY_ID, 'forced-hand-discard')).toThrow(/unexpected behaviorId/);
	});

	// -------------------------------------------------------------------------
	// Fixtures
	// -------------------------------------------------------------------------

	/** Two participants, freshly begun, still in the `'deal'` stage — for
	 * Black Honey, which must apply before/around dealing. */
	function beginTwoPlayer(seed: string, enemyFacts: ChallengeEnemyFact[] = []) {
		const state = makeSessionFixture(seed);
		const gmCtx = ctxFor(GM, catalog, config, seed);
		const begun = beginChallenge(state, { participantTenureIds: ['tenure-1', 'tenure-2'], tenureOwners: TENURE_OWNERS, enemyFacts }, gmCtx);
		if (!begun.ok) throw begun;
		return { state: begun.state, gmCtx };
	}

	/** Dealt and ready to place Initiative (stage `'initiative-placement'`) —
	 * for Brainfever, which forces a placement. */
	function dealtTwoPlayer(seed: string) {
		const { state, gmCtx } = beginTwoPlayer(seed);
		const dealResult = dealRound(state, gmCtx);
		if (!dealResult.ok) throw dealResult;
		return { state: dealResult.state, gmCtx };
	}

	/** Two participants, both through Initiative, turns begun — tenure-1's
	 * Initiative card is forced LOW so it goes first (the active seat); each
	 * keeps a separate `extraHand` for the actual modifier under test,
	 * distinct from the card already consumed by Initiative placement. */
	function readyTwoPlayerTurns(seed: string, extraHand1: CardId[], extraHand2: CardId[]) {
		const { state, gmCtx } = dealtTwoPlayer(seed);
		const forced1 = forceHand(state, 'tenure-1', ['swords-i', ...extraHand1]);
		const forced2 = forceHand(forced1, 'tenure-2', ['wands-king', ...extraHand2]);

		const p1Ctx = ctxFor(playerActor('tenure-1'), catalog, config, seed);
		const p2Ctx = ctxFor(playerActor('tenure-2'), catalog, config, seed);
		const placed1 = placeInitiative(forced2, 'tenure-1', 'swords-i', p1Ctx);
		if (!placed1.ok) throw placed1;
		const placed2 = placeInitiative(placed1.state, 'tenure-2', 'wands-king', p2Ctx);
		if (!placed2.ok) throw placed2;
		const revealed = revealInitiative(placed2.state, gmCtx);
		if (!revealed.ok) throw revealed;
		const begunTurns = beginTurns(revealed.state, gmCtx);
		if (!begunTurns.ok) throw begunTurns;

		return { state: begunTurns.state, gmCtx, p1Ctx, p2Ctx };
	}

	// -------------------------------------------------------------------------
	// Black Honey — optional-hand-size
	// -------------------------------------------------------------------------

	describe('applyBlackHoney', () => {
		it("changes the affected participant's configured deal count (Step 1)", () => {
			const { state, gmCtx } = beginTwoPlayer('black-honey-deal-count');
			const applied = applyBlackHoney(state, 'tenure-1', blackHoneyParams, gmCtx);
			expect(applied.ok).toBe(true);
			if (!applied.ok) return;

			const dealResult = dealRound(applied.state, gmCtx);
			expect(dealResult.ok).toBe(true);
			if (!dealResult.ok) return;

			const hand1 = findZoneDescriptor(dealResult.state, challengeHandZoneId('tenure-1'))!.cards.length;
			const hand2 = findZoneDescriptor(dealResult.state, challengeHandZoneId('tenure-2'))!.cards.length;
			expect(hand1).toBe(blackHoneyParams.optionalCards);
			expect(hand2).toBe(blackHoneyParams.normalCards);
			expect(config.playerBaseHandSize).toBe(blackHoneyParams.normalCards);
			expectConserved(dealResult.state, catalog);
		});

		it('records a resolved modifier instance and a manual-consequence-required event carrying teethLost* verbatim from content', () => {
			const { state, gmCtx } = beginTwoPlayer('black-honey-consequence');
			const applied = applyBlackHoney(state, 'tenure-1', blackHoneyParams, gmCtx);
			expect(applied.ok).toBe(true);
			if (!applied.ok) return;

			expect(readChallengeState(applied.state)?.modifiers).toContainEqual(
				expect.objectContaining({ modifierId: CHALLENGE_BLACK_HONEY_ID, targetTenureId: 'tenure-1', status: 'resolved' })
			);
			const consequence = applied.events.find((event) => event.kind === 'manual-consequence-required');
			expect(consequence?.publicPayload).toMatchObject({
				modifierId: CHALLENGE_BLACK_HONEY_ID,
				targetTenureId: 'tenure-1',
				teethLostFrom: blackHoneyParams.teethLostFrom,
				teethLostTo: blackHoneyParams.teethLostTo
			});
		});

		it('rejects eating Black Honey twice in the same round for the same tenure', () => {
			const { state, gmCtx } = beginTwoPlayer('black-honey-twice');
			const first = applyBlackHoney(state, 'tenure-1', blackHoneyParams, gmCtx);
			if (!first.ok) throw first;
			const second = applyBlackHoney(first.state, 'tenure-1', blackHoneyParams, gmCtx);
			expect(second).toMatchObject({ ok: false, rejection: { code: 'illegal-command', message: expect.stringContaining('already eaten') } });
		});

		it('rejects a non-GM actor distinctly from the stage guard (test discrimination)', () => {
			const { state, gmCtx } = beginTwoPlayer('black-honey-not-gm');
			const result = applyBlackHoney(state, 'tenure-1', blackHoneyParams, ctxFor(playerActor('tenure-1'), catalog, config, 'black-honey-not-gm'));
			expect(result).toMatchObject({ ok: false, rejection: { code: 'not-authorized' } });

			// The stage guard is a SEPARATE check: advance past `'deal'` and
			// confirm a GM attempt now fails on stage, not authorization.
			const dealResult = dealRound(state, gmCtx);
			if (!dealResult.ok) throw dealResult;
			const late = applyBlackHoney(dealResult.state, 'tenure-1', blackHoneyParams, gmCtx);
			expect(late).toMatchObject({ ok: false, rejection: { code: 'illegal-command', message: expect.stringContaining('stage') } });
		});
	});

	// -------------------------------------------------------------------------
	// Stun — forced-hand-discard
	// -------------------------------------------------------------------------

	describe('applyStun / resolveStun — GM records a pending instance, the target resolves it (review round 4)', () => {
		it('applyStun records a pending instance; resolveStun then discards exactly the ONE card the target chooses and emits a public COUNT, never identity (Step 1 / O3)', () => {
			const { state, gmCtx, p2Ctx } = readyTwoPlayerTurns('stun-basic', ['swords-vii', 'cups-ii'], ['pentacles-iv', 'cups-iii']);
			const hand2Before = findZoneDescriptor(state, challengeHandZoneId('tenure-2'))!.cards.slice();
			expect(hand2Before).toEqual(['pentacles-iv', 'cups-iii']);

			const recorded = applyStun(state, 'tenure-2', stunParams, gmCtx);
			expect(recorded.ok).toBe(true);
			if (!recorded.ok) return;
			expect(recorded.events).toEqual([
				expect.objectContaining({ kind: 'challenge-stun-inflicted', publicPayload: expect.objectContaining({ targetTenureId: 'tenure-2' }) })
			]);
			expect(readChallengeState(recorded.state)?.modifiers).toContainEqual(
				expect.objectContaining({ modifierId: CHALLENGE_STUN_ID, targetTenureId: 'tenure-2', status: 'pending' })
			);

			const result = resolveStun(recorded.state, 'tenure-2', 'cups-iii', stunParams, p2Ctx);
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			// Exactly the CHOSEN card is gone; the rest of the hand survives.
			expect(findZoneDescriptor(result.state, challengeHandZoneId('tenure-2'))?.cards).toEqual(['pentacles-iv']);
			expect(readChallengeState(result.state)?.modifiers).toContainEqual(
				expect.objectContaining({ modifierId: CHALLENGE_STUN_ID, targetTenureId: 'tenure-2', status: 'resolved' })
			);
			expect(result.events).toHaveLength(1);
			expect(result.events[0]).toMatchObject({
				kind: 'challenge-stun-applied',
				publicPayload: { targetTenureId: 'tenure-2', count: 1, playerChooses: true }
			});
			// Canary: the discarded card's identity never leaked into the public
			// payload, even though it DID land in a public-top discard pile (the
			// underlying discard is never surfaced as a separate event here —
			// see `modifiers.ts`'s doc comment).
			const serializedPublic = JSON.stringify(result.events[0].publicPayload);
			expect(serializedPublic).not.toContain('cups-iii');
			expect(result.events[0].privatePayloads).toBeUndefined();

			// Minor 4 (review round 2): the event-layer guarantee above is NOT a
			// state-layer one — the shared engine's own `'public-top'` discard
			// pile model means the discarded card genuinely becomes public via
			// every projection's `playerDiscardTop`. Asserted explicitly so this
			// reads as an accepted, documented exposure, not a stronger
			// guarantee than the code gives.
			const publicProjection = projectForActor(result.state, GM, catalog).public;
			expect(publicProjection.playerDiscardTop).toMatchObject({ hidden: false, id: 'cups-iii' });

			expectConserved(result.state, catalog);
		});

		it('rejects a player invoking apply-stun (recording is GM-only — a player cannot self-serve a trigger)', () => {
			const { state } = readyTwoPlayerTurns('stun-record-not-gm', ['swords-vii'], ['pentacles-iv']);
			const result = applyStun(state, 'tenure-2', stunParams, ctxFor(playerActor('tenure-1'), catalog, config, 'stun-record-not-gm'));
			expect(result).toMatchObject({ ok: false, rejection: { code: 'not-authorized' } });
		});

		it('rejects resolveStun with NO pending instance recorded — closes the hole: a player cannot self-serve a discard unprompted (review round 4, the core fix)', () => {
			const { state, p1Ctx } = readyTwoPlayerTurns('stun-no-pending', ['swords-vii'], ['pentacles-iv']);
			expect(readChallengeState(state)?.modifiers).toEqual([]);

			const result = resolveStun(state, 'tenure-1', 'swords-vii', stunParams, p1Ctx);
			expect(result).toMatchObject({
				ok: false,
				rejection: { code: 'illegal-command', message: expect.stringContaining('has no pending Stun') }
			});
			expectConserved(state, catalog);
		});

		it('rejects a GM attempt to resolveStun directly — playerChooses is enforced, not just surfaced: no full-authority override here (test discrimination against the not-authorized message the GM would otherwise get elsewhere)', () => {
			const { state, gmCtx } = readyTwoPlayerTurns('stun-gm-cannot-resolve', ['swords-vii'], ['pentacles-iv']);
			const recorded = applyStun(state, 'tenure-1', stunParams, gmCtx);
			if (!recorded.ok) throw recorded;
			const result = resolveStun(recorded.state, 'tenure-1', 'swords-vii', stunParams, gmCtx);
			expect(result).toMatchObject({
				ok: false,
				rejection: { code: 'not-authorized', message: expect.stringContaining('only the stunned player') }
			});
		});

		it('rejects a player resolving a discard on behalf of a tenure they do not own, distinctly from the no-pending-instance guard (test discrimination)', () => {
			const { state, gmCtx } = readyTwoPlayerTurns('stun-not-owner', ['swords-vii'], ['pentacles-iv']);
			const recorded = applyStun(state, 'tenure-2', stunParams, gmCtx);
			if (!recorded.ok) throw recorded;
			const result = resolveStun(recorded.state, 'tenure-2', 'pentacles-iv', stunParams, ctxFor(playerActor('tenure-1'), catalog, config, 'stun-not-owner'));
			expect(result).toMatchObject({ ok: false, rejection: { code: 'not-authorized' } });
		});

		it('rejects resolving a card the target does not hold, even with a valid pending instance (Minor 9 edge case, e.g. an already-empty hand)', () => {
			const { state, gmCtx } = readyTwoPlayerTurns('stun-empty-hand', [], []);
			expect(findZoneDescriptor(state, challengeHandZoneId('tenure-2'))?.cards).toEqual([]);
			const recorded = applyStun(state, 'tenure-2', stunParams, gmCtx);
			if (!recorded.ok) throw recorded;

			const p2Ctx = ctxFor(playerActor('tenure-2'), catalog, config, 'stun-empty-hand');
			const result = resolveStun(recorded.state, 'tenure-2', 'pentacles-iv', stunParams, p2Ctx);
			expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command', message: expect.stringContaining('does not hold') } });
			expectConserved(recorded.state, catalog);
		});

		it('carries no invented stage restriction — Ch1 "Effects" says Stun is immediate/instantaneous, so applyStun/resolveStun may run at ANY stage of an active Challenge (Minor 6)', () => {
			const { state: dealStage, gmCtx: dealGmCtx } = beginTwoPlayer('stun-any-stage-deal');
			expect(readChallengeState(dealStage)?.stage).toBe('deal');
			expect(applyStun(dealStage, 'tenure-1', stunParams, dealGmCtx).ok).toBe(true);

			const { state: placementState, gmCtx: placementGmCtx } = dealtTwoPlayer('stun-any-stage-placement');
			expect(readChallengeState(placementState)?.stage).toBe('initiative-placement');
			const recorded = applyStun(placementState, 'tenure-1', stunParams, placementGmCtx);
			if (!recorded.ok) throw recorded;
			const heldCard = findZoneDescriptor(recorded.state, challengeHandZoneId('tenure-1'))!.cards[0];
			const p1Ctx = ctxFor(playerActor('tenure-1'), catalog, config, 'stun-any-stage-placement');
			expect(resolveStun(recorded.state, 'tenure-1', heldCard, stunParams, p1Ctx).ok).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// Brainfever — forced-initiative-selection
	// -------------------------------------------------------------------------

	describe('applyBrainfever', () => {
		it('chooses the lowest-value eligible Initiative card, with no tie (Step 1)', () => {
			const { state, gmCtx } = dealtTwoPlayer('brainfever-no-tie');
			const forced = forceHand(state, 'tenure-1', ['swords-vii', 'cups-ii', 'wands-iii', 'pentacles-iv']);

			const result = applyBrainfever(forced, 'tenure-1', brainfeverParams, gmCtx);
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			expect(findZoneDescriptor(result.state, challengeInitiativeFacedownZoneId('tenure-1'))?.cards).toEqual(['cups-ii']);
			expect(readChallengeState(result.state)?.initiativeOrder).toContainEqual({
				tenureId: 'tenure-1',
				cardZoneId: challengeInitiativeFacedownZoneId('tenure-1'),
				revealed: false
			});
			expect(result.events.map((e) => e.kind)).toEqual(['challenge-brainfever-forced-initiative']);
			expect(result.events[0].publicPayload).toMatchObject({ targetTenureId: 'tenure-1', tieBroken: false });
			// The chosen card's identity is NOT public — this is a facedown
			// Initiative placement, identical privacy to an ordinary one.
			expect(JSON.stringify(result.events[0].publicPayload)).not.toContain('cups-ii');
			expectConserved(result.state, catalog);
		});

		it('records a stable card-ID tie break when two cards share the lowest value', () => {
			const { state, gmCtx } = dealtTwoPlayer('brainfever-tie');
			// 'cups-ii' and 'swords-ii' both have value 2; 'cups-ii' < 'swords-ii'
			// by ascending card-id sort, so it is the deterministic pick.
			const forced = forceHand(state, 'tenure-1', ['swords-ii', 'cups-ii', 'wands-iii', 'pentacles-iv']);

			const result = applyBrainfever(forced, 'tenure-1', brainfeverParams, gmCtx);
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			expect(findZoneDescriptor(result.state, challengeInitiativeFacedownZoneId('tenure-1'))?.cards).toEqual(['cups-ii']);
			expect(result.events[0].publicPayload).toMatchObject({ tieBroken: true });
		});

		it('rejects a non-GM actor', () => {
			const { state } = dealtTwoPlayer('brainfever-not-gm');
			const result = applyBrainfever(state, 'tenure-1', brainfeverParams, ctxFor(playerActor('tenure-1'), catalog, config, 'brainfever-not-gm'));
			expect(result).toMatchObject({ ok: false, rejection: { code: 'not-authorized' } });
		});

		it('rejects the wrong stage distinctly (test discrimination)', () => {
			const { state, gmCtx } = beginTwoPlayer('brainfever-wrong-stage');
			const result = applyBrainfever(state, 'tenure-1', brainfeverParams, gmCtx);
			expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command', message: expect.stringContaining('stage') } });
		});
	});

	// -------------------------------------------------------------------------
	// Guardian Angel — guardian-angel-defense
	// -------------------------------------------------------------------------

	describe('applyGuardianAngel', () => {
		it("performs its audited private/public move as specified by content (Step 1): the caster's card ends up facedown in the TARGET's zone", () => {
			const { state, gmCtx, p1Ctx } = readyTwoPlayerTurns('guardian-angel-basic', ['wands-v', 'cups-ii'], ['pentacles-iv']);

			const result = applyGuardianAngel(state, 'tenure-1', 'tenure-2', 'wands-v', guardianAngelParams, p1Ctx);
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			expect(findZoneDescriptor(result.state, challengeHandZoneId('tenure-1'))?.cards).not.toContain('wands-v');
			expect(findZoneDescriptor(result.state, challengeGuardianAngelZoneId('tenure-2'))?.cards).toEqual(['wands-v']);
			// The transient caster-owned staging zone is empty again — the card
			// really moved through it, it didn't stay.
			expect(findZoneDescriptor(result.state, challengeGuardianAngelStagingZoneId('tenure-1'))?.cards).toEqual([]);
			expect(readChallengeState(result.state)?.budgets['tenure-1']).toMatchObject({ cardsThisTurn: 1, actionTaken: true });
			expect(readChallengeState(result.state)?.modifiers).toContainEqual(
				expect.objectContaining({ modifierId: CHALLENGE_GUARDIAN_ANGEL_ID, ownerTenureId: 'tenure-1', targetTenureId: 'tenure-2', status: 'active' })
			);

			// Privacy canary: neither event's PUBLIC payload carries the card's
			// identity anywhere.
			for (const event of result.events) {
				expect(JSON.stringify(event.publicPayload)).not.toContain('wands-v');
			}
			// The target privately learns the card id (their own projection
			// needs it); the GM's own projection never does — a private zone
			// owned by a player is never surfaced to the GM beyond a count
			// (`projection.ts`'s `SessionGmProjection` has no player-hand field).
			const handoffEvent = result.events.find((event) => event.kind === 'challenge-guardian-angel-warded');
			expect(handoffEvent?.privatePayloads?.[TENURE_OWNERS['tenure-2']]).toMatchObject({ cardId: 'wands-v' });

			const gmProjection = projectForActor(result.state, GM, catalog) as SessionGmProjection;
			expect(JSON.stringify(gmProjection)).not.toContain('wands-v');
			const targetProjection = projectForActor(result.state, playerActor('tenure-2'), catalog) as SessionPlayerProjection;
			expect(targetProjection.privateFacedown.some((slot) => !slot.hidden && slot.id === 'wands-v')).toBe(true);

			expectConserved(result.state, catalog);
		});

		it('permits self-targeting — the rule text never restricts who the target may be, unlike Counsel (Minor 7)', () => {
			const { state, p1Ctx } = readyTwoPlayerTurns('guardian-angel-self', ['wands-v'], ['pentacles-iv']);
			const result = applyGuardianAngel(state, 'tenure-1', 'tenure-1', 'wands-v', guardianAngelParams, p1Ctx);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(findZoneDescriptor(result.state, challengeGuardianAngelZoneId('tenure-1'))?.cards).toEqual(['wands-v']);
			expectConserved(result.state, catalog);
		});

		it('rejects casting a second Guardian Angel while the caster already has an active one (maxInstances: 1), isolated from a FRESH turn budget (Important 3 fix)', () => {
			const seed = 'guardian-angel-cap';
			const { state, gmCtx, p1Ctx } = readyTwoPlayerTurns(seed, ['wands-v'], ['pentacles-iv']);
			const first = applyGuardianAngel(state, 'tenure-1', 'tenure-2', 'wands-v', guardianAngelParams, p1Ctx);
			if (!first.ok) throw first;

			// Cycle a full round boundary — end both turns, clean up (which
			// CARRIES the active Guardian Angel instance forward, exactly as
			// `duration: 'until-used'` requires), deal again, and re-enter
			// `'turns'` with tenure-1 active and a genuinely FRESH per-turn
			// budget. This isolates the `maxInstances` guard from `spendCard`'s
			// own cap — the earlier version of this test only proved a
			// rejection occurred, not WHICH guard caused it, since both were
			// simultaneously true (review, Important 3).
			const p2Ctx = ctxFor(playerActor('tenure-2'), catalog, config, seed);
			const endedFirst = endTurn(first.state, p1Ctx);
			if (!endedFirst.ok) throw endedFirst;
			const endedSecond = endTurn(endedFirst.state, p2Ctx);
			if (!endedSecond.ok) throw endedSecond;
			const cleaned = cleanupRound(endedSecond.state, gmCtx);
			if (!cleaned.ok) throw cleaned;
			expect(readChallengeState(cleaned.state)?.modifiers).toContainEqual(
				expect.objectContaining({ modifierId: CHALLENGE_GUARDIAN_ANGEL_ID, status: 'active' })
			);

			const dealResult = dealRound(cleaned.state, gmCtx);
			if (!dealResult.ok) throw dealResult;
			// Fresh card ids, disjoint from round 1's set (`swords-i`, `wands-v`,
			// `wands-king`, `pentacles-iv`) — see the fixture's own doc comment
			// on why round-1 identities can't safely be reused here.
			const forced1 = forceHand(dealResult.state, 'tenure-1', ['swords-ii', 'cups-iii']);
			const forced2 = forceHand(forced1, 'tenure-2', ['wands-queen']);
			const placed1 = placeInitiative(forced2, 'tenure-1', 'swords-ii', p1Ctx);
			if (!placed1.ok) throw placed1;
			const placed2 = placeInitiative(placed1.state, 'tenure-2', 'wands-queen', p2Ctx);
			if (!placed2.ok) throw placed2;
			const revealed = revealInitiative(placed2.state, gmCtx);
			if (!revealed.ok) throw revealed;
			const begunTurns = beginTurns(revealed.state, gmCtx);
			if (!begunTurns.ok) throw begunTurns;
			expect(readChallengeState(begunTurns.state)?.budgets['tenure-1']).toMatchObject({ cardsThisTurn: 0, actionTaken: false });

			const second = applyGuardianAngel(begunTurns.state, 'tenure-1', 'tenure-2', 'cups-iii', guardianAngelParams, p1Ctx);
			expect(second).toMatchObject({ ok: false, rejection: { code: 'illegal-command', message: expect.stringContaining('maxInstances') } });
		});

		it('rejects a player casting on behalf of a tenure they do not own (O4 — a syntactically valid but unauthorized command)', () => {
			const { state } = readyTwoPlayerTurns('guardian-angel-impersonation', ['wands-v'], ['pentacles-iv']);
			const impersonator = ctxFor(playerActor('tenure-2'), catalog, config, 'guardian-angel-impersonation');
			const result = applyGuardianAngel(state, 'tenure-1', 'tenure-2', 'wands-v', guardianAngelParams, impersonator);
			expect(result).toMatchObject({ ok: false, rejection: { code: 'not-authorized' } });
		});
	});

	// -------------------------------------------------------------------------
	// resolveGuardianAngel — the "used" consumption Important 2 requires
	// -------------------------------------------------------------------------

	describe('resolveGuardianAngel', () => {
		function castGuardianAngel(seed: string) {
			const { state, gmCtx, p1Ctx, p2Ctx } = readyTwoPlayerTurns(seed, ['wands-v'], ['pentacles-iv']);
			const cast = applyGuardianAngel(state, 'tenure-1', 'tenure-2', 'wands-v', guardianAngelParams, p1Ctx);
			if (!cast.ok) throw cast;
			return { state: cast.state, gmCtx, p1Ctx, p2Ctx };
		}

		it("flips the ward to 'resolved' and discards the card once flipped up to Dodge or Riposte (Ch7: \"Once your Dodge/Riposte card is resolved, discard the card\") — freeing the maxInstances lockout", () => {
			const { state, p2Ctx } = castGuardianAngel('guardian-angel-resolve');

			const resolved = resolveGuardianAngel(state, 'tenure-2', 'wands-v', 'dodge', p2Ctx);
			expect(resolved.ok).toBe(true);
			if (!resolved.ok) return;

			expect(findZoneDescriptor(resolved.state, challengeGuardianAngelZoneId('tenure-2'))?.cards).toEqual([]);
			expect(resolved.state.playerDiscard).toContain('wands-v');
			expect(readChallengeState(resolved.state)?.modifiers).toContainEqual(
				expect.objectContaining({ modifierId: CHALLENGE_GUARDIAN_ANGEL_ID, ownerTenureId: 'tenure-1', status: 'resolved' })
			);
			const consequence = resolved.events.find((event) => event.kind === 'manual-consequence-required');
			expect(consequence?.publicPayload).toMatchObject({ modifierId: CHALLENGE_GUARDIAN_ANGEL_ID, targetTenureId: 'tenure-2', consequence: 'apply-guardian-angel-bonus-to-dodge' });
			expectConserved(resolved.state, catalog);

			// Once resolved, the caster's maxInstances lockout is freed — no
			// `'active'` instance remains for tenure-1, so `applyGuardianAngel`'s
			// own cap-counting (`activeInstanceCount >= params.maxInstances`)
			// would admit a fresh cast (a real re-cast additionally needs a fresh
			// per-turn budget — exercised together in the maxInstances test
			// above; this isolates the "consumption frees the cap" claim from
			// the separate "fresh turn" concern).
			const activeCountAfterResolve = readChallengeState(resolved.state)!.modifiers.filter(
				(modifier) => modifier.modifierId === CHALLENGE_GUARDIAN_ANGEL_ID && modifier.ownerTenureId === 'tenure-1' && modifier.status === 'active'
			).length;
			expect(activeCountAfterResolve).toBe(0);
			expect(activeCountAfterResolve).toBeLessThan(guardianAngelParams.maxInstances);
		});

		it('rejects resolving a Guardian Angel that has already been resolved (no double-consumption) — the card is gone, so this pins the ZONE-membership guard specifically (round-2 review, Item 3: distinct from the separate instance-lookup guard below)', () => {
			const { state, p2Ctx } = castGuardianAngel('guardian-angel-resolve-twice');
			const first = resolveGuardianAngel(state, 'tenure-2', 'wands-v', 'dodge', p2Ctx);
			if (!first.ok) throw first;
			const second = resolveGuardianAngel(first.state, 'tenure-2', 'wands-v', 'dodge', p2Ctx);
			expect(second).toMatchObject({
				ok: false,
				rejection: { code: 'illegal-command', message: expect.stringContaining('has no Guardian Angel card') }
			});
		});

		it('rejects resolving a card that IS still physically present but has no matching active modifier instance — an inconsistent state only constructed here to isolate the instance-lookup guard from the zone-membership guard above (round-2 review, Item 3)', () => {
			const { state } = castGuardianAngel('guardian-angel-resolve-orphan-card');
			const p2Ctx = ctxFor(playerActor('tenure-2'), catalog, config, 'guardian-angel-resolve-orphan-card');

			// Directly plant a real, catalog-valid card into tenure-2's Guardian
			// Angel zone WITHOUT registering a matching `ChallengeModifierState`
			// instance — not reachable through any real command, only
			// constructed to prove the instance-lookup guard fires on its own.
			const orphanCardId = findZoneDescriptor(state, challengeHandZoneId('tenure-2'))!.cards[0];
			const gaZoneId = challengeGuardianAngelZoneId('tenure-2');
			const withOrphanCard: SessionEngineStateV1 = {
				...state,
				privateZones: state.privateZones
					.map((zone) => (zone.id === challengeHandZoneId('tenure-2') ? { ...zone, cards: zone.cards.filter((id) => id !== orphanCardId) } : zone))
					.map((zone) => (zone.id === gaZoneId ? { ...zone, cards: zone.cards.concat(orphanCardId) } : zone))
			};

			const result = resolveGuardianAngel(withOrphanCard, 'tenure-2', orphanCardId, 'dodge', p2Ctx);
			expect(result).toMatchObject({
				ok: false,
				rejection: { code: 'illegal-command', message: expect.stringContaining('has no active Guardian Angel instance') }
			});
		});

		it('rejects a non-owning player resolving another tenure\'s ward', () => {
			const { state } = castGuardianAngel('guardian-angel-resolve-not-owner');
			const impersonator = ctxFor(playerActor('tenure-1'), catalog, config, 'guardian-angel-resolve-not-owner');
			const result = resolveGuardianAngel(state, 'tenure-2', 'wands-v', 'dodge', impersonator);
			expect(result).toMatchObject({ ok: false, rejection: { code: 'not-authorized' } });
		});
	});

	// -------------------------------------------------------------------------
	// Aim — prepared-facedown-bonus
	// -------------------------------------------------------------------------

	describe('prepareAim / resolveAim', () => {
		it('creates and consumes the typed prepared/face-down zone (Step 1)', () => {
			const { state, p1Ctx } = readyTwoPlayerTurns('aim-create-consume', ['swords-vii', 'cups-ii'], ['pentacles-iv']);

			const prepared = prepareAim(state, 'tenure-1', 'swords-vii', true, aimParams, p1Ctx);
			expect(prepared.ok).toBe(true);
			if (!prepared.ok) return;
			expect(findZoneDescriptor(prepared.state, challengeAimZoneId('tenure-1'))?.cards).toEqual(['swords-vii']);
			expect(findZoneDescriptor(prepared.state, challengeHandZoneId('tenure-1'))?.cards).not.toContain('swords-vii');
			expect(JSON.stringify(prepared.events[0].publicPayload)).not.toContain('swords-vii');
			expect(prepared.events[0].privatePayloads?.[TENURE_OWNERS['tenure-1']]).toBeDefined();

			const resolved = resolveAim(prepared.state, 'tenure-1', 'swords-vii', aimParams, p1Ctx);
			expect(resolved.ok).toBe(true);
			if (!resolved.ok) return;
			expect(findZoneDescriptor(resolved.state, challengeAimZoneId('tenure-1'))?.cards).toEqual([]);
			expect(resolved.state.playerDiscard).toContain('swords-vii');
			const consequence = resolved.events.find((event) => event.kind === 'manual-consequence-required');
			expect(consequence?.publicPayload).toMatchObject({ modifierId: CHALLENGE_AIM_ID, tenureId: 'tenure-1', bonusValue: 7 });

			expectConserved(resolved.state, catalog);
		});

		it('rejects a card whose suit is not Swords (content param, not a hardcoded literal)', () => {
			const { state, p1Ctx } = readyTwoPlayerTurns('aim-wrong-suit', ['cups-ii'], ['pentacles-iv']);
			const result = prepareAim(state, 'tenure-1', 'cups-ii', true, aimParams, p1Ctx);
			expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
		});

		it('rejects preparing Aim without a bow, distinctly from the suit guard (test discrimination)', () => {
			const { state, p1Ctx } = readyTwoPlayerTurns('aim-no-bow', ['swords-vii'], ['pentacles-iv']);
			const result = prepareAim(state, 'tenure-1', 'swords-vii', false, aimParams, p1Ctx);
			expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command', message: expect.stringContaining('bow') } });
		});

		it('rejects resolving the same prepared Aim card twice (Minor 9 edge case) — already consumed, no longer present', () => {
			const { state, p1Ctx } = readyTwoPlayerTurns('aim-resolve-twice', ['swords-vii'], ['pentacles-iv']);
			const prepared = prepareAim(state, 'tenure-1', 'swords-vii', true, aimParams, p1Ctx);
			if (!prepared.ok) throw prepared;
			const first = resolveAim(prepared.state, 'tenure-1', 'swords-vii', aimParams, p1Ctx);
			if (!first.ok) throw first;

			const second = resolveAim(first.state, 'tenure-1', 'swords-vii', aimParams, p1Ctx);
			expect(second).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
			expectConserved(first.state, catalog);
		});
	});

	// -------------------------------------------------------------------------
	// Guard — replace-initiative (O2, Ch7:552-554)
	// -------------------------------------------------------------------------

	describe('applyGuard', () => {
		it("replaces the actor's public Initiative with any card from their private hand and discards the old Initiative (Step 1)", () => {
			const { state, p1Ctx } = readyTwoPlayerTurns('guard-basic', ['pentacles-x', 'cups-ii'], ['pentacles-iv']);
			// tenure-1's placed Initiative card is 'swords-i' — a DIFFERENT suit
			// than the replacement, proving "accepts any suit" (Ch7:552-554).
			const before = readChallengeState(state)!.initiativeOrder.find((entry) => entry.tenureId === 'tenure-1');
			expect(before?.cardId).toBe('swords-i');

			const result = applyGuard(state, 'tenure-1', 'pentacles-x', true, guardParams, p1Ctx);
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			const initiativeZone = findZoneDescriptor(result.state, CHALLENGE_INITIATIVE_ZONE_ID)!;
			expect(initiativeZone.cards).not.toContain('swords-i');
			expect(initiativeZone.cards).toContain('pentacles-x');
			expect(result.state.playerDiscard).toContain('swords-i');
			expect(readChallengeState(result.state)?.initiativeOrder).toContainEqual(
				expect.objectContaining({ tenureId: 'tenure-1', cardId: 'pentacles-x', revealed: true })
			);
			expect(readChallengeState(result.state)?.budgets['tenure-1']).toMatchObject({ cardsThisTurn: 1, actionTaken: true });
			expectConserved(result.state, catalog);
		});

		it('rejects Guard without a shield, distinctly from every other guard (test discrimination)', () => {
			const { state, p1Ctx } = readyTwoPlayerTurns('guard-no-shield', ['pentacles-x'], ['pentacles-iv']);
			const result = applyGuard(state, 'tenure-1', 'pentacles-x', false, guardParams, p1Ctx);
			expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command', message: expect.stringContaining('shield') } });
		});

		it('rejects a player replacing a tenure they do not own — the command is syntactically valid but not offered to them (O4)', () => {
			const { state } = readyTwoPlayerTurns('guard-not-owner', ['pentacles-x'], ['pentacles-iv']);
			const impersonator = ctxFor(playerActor('tenure-2'), catalog, config, 'guard-not-owner');
			const result = applyGuard(state, 'tenure-1', 'pentacles-x', true, guardParams, impersonator);
			expect(result).toMatchObject({ ok: false, rejection: { code: 'not-authorized' } });
		});

		it('rejects Guard outside the turns stage, distinctly from the shield/ownership guards (test discrimination)', () => {
			const { state, gmCtx } = dealtTwoPlayer('guard-wrong-stage');
			const result = applyGuard(state, 'tenure-1', 'swords-i', true, guardParams, ctxFor(playerActor('tenure-1'), catalog, config, 'guard-wrong-stage'));
			expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
			// (never reaches the shield check's specific message)
			expect((result as { rejection: { message: string } }).rejection.message).not.toContain('shield');
		});

		it("updates BOTH initiativeOrder entries sharing the tenure's id when a Fool-extra bonus turn is in play (Minor 9 — O7's double-render hazard)", () => {
			const seed = 'guard-fool-extra';
			const { state, p1Ctx } = readyTwoPlayerTurns(seed, ['fool', 'wands-iii', 'pentacles-x'], ['pentacles-iv']);

			// tenure-1 plays the Fool paired with 'wands-iii' — this inserts a
			// SECOND `initiativeOrder` entry for tenure-1 (`turnKind: 'fool-extra'`)
			// that CLONES the current entry, sharing `tenureId`/`cardZoneId`/
			// `cardId` with the original (`fool.ts`'s `playFool`).
			const played = playFool(state, 'tenure-1', 'wands-iii', p1Ctx);
			if (!played.ok) throw played;
			const beforeGuard = readChallengeState(played.state)!.initiativeOrder.filter((entry) => entry.tenureId === 'tenure-1');
			expect(beforeGuard).toHaveLength(2);
			expect(beforeGuard.every((entry) => entry.cardId === 'swords-i')).toBe(true);

			// End the original turn to enter the fool-extra bonus turn — a
			// FRESH budget for the same tenure (Task 3's `endTurn`), which is
			// what makes Guard legal here at all.
			const ended = endTurn(played.state, p1Ctx);
			if (!ended.ok) throw ended;
			expect(readChallengeState(ended.state)?.turnKind).toBe('fool-extra');

			const guarded = applyGuard(ended.state, 'tenure-1', 'pentacles-x', true, guardParams, p1Ctx);
			expect(guarded.ok).toBe(true);
			if (!guarded.ok) return;

			const afterGuard = readChallengeState(guarded.state)!.initiativeOrder.filter((entry) => entry.tenureId === 'tenure-1');
			expect(afterGuard).toHaveLength(2);
			// BOTH entries updated together — not just one left stale, and not a
			// THIRD entry accidentally created with a colliding zone id.
			expect(afterGuard.every((entry) => entry.cardId === 'pentacles-x')).toBe(true);
			const initiativeZone = findZoneDescriptor(guarded.state, CHALLENGE_INITIATIVE_ZONE_ID)!;
			expect(initiativeZone.cards).not.toContain('swords-i');
			expect(initiativeZone.cards).toContain('pentacles-x');
			expectConserved(guarded.state, catalog);
		});
	});

	// -------------------------------------------------------------------------
	// Round-boundary persistence (reducer.ts's filtered `modifiers` reset)
	// -------------------------------------------------------------------------

	it("Guardian Angel's active instance survives round cleanup (duration: until-used spans rounds); Black Honey's resolved gate does not", () => {
		const seed = 'cleanup-persistence';
		// Black Honey must apply during `'deal'`, BEFORE `readyTwoPlayerTurns`'s
		// own flow advances past it — so this test builds its own sequence
		// rather than reusing that fixture.
		const { state: begunState, gmCtx } = beginTwoPlayer(seed);
		const bh = applyBlackHoney(begunState, 'tenure-1', blackHoneyParams, gmCtx);
		if (!bh.ok) throw bh;

		const dealResult = dealRound(bh.state, gmCtx);
		if (!dealResult.ok) throw dealResult;
		const forced1 = forceHand(dealResult.state, 'tenure-1', ['swords-i', 'wands-v', 'cups-ii']);
		const forced2 = forceHand(forced1, 'tenure-2', ['wands-king', 'pentacles-iv']);
		const p1Ctx = ctxFor(playerActor('tenure-1'), catalog, config, seed);
		const p2Ctx = ctxFor(playerActor('tenure-2'), catalog, config, seed);
		const placed1 = placeInitiative(forced2, 'tenure-1', 'swords-i', p1Ctx);
		if (!placed1.ok) throw placed1;
		const placed2 = placeInitiative(placed1.state, 'tenure-2', 'wands-king', p2Ctx);
		if (!placed2.ok) throw placed2;
		const revealed = revealInitiative(placed2.state, gmCtx);
		if (!revealed.ok) throw revealed;
		const begunTurns = beginTurns(revealed.state, gmCtx);
		if (!begunTurns.ok) throw begunTurns;

		const ga = applyGuardianAngel(begunTurns.state, 'tenure-1', 'tenure-2', 'wands-v', guardianAngelParams, p1Ctx);
		if (!ga.ok) throw ga;

		expect(readChallengeState(ga.state)?.modifiers).toHaveLength(2);

		const cleaned = cleanupRound(ga.state, gmCtx);
		expect(cleaned.ok).toBe(true);
		if (!cleaned.ok) return;

		const afterCleanup = readChallengeState(cleaned.state)!;
		expect(afterCleanup.modifiers).toHaveLength(1);
		expect(afterCleanup.modifiers[0]).toMatchObject({ modifierId: CHALLENGE_GUARDIAN_ANGEL_ID, status: 'active' });
		// The physical card is untouched too — facedown zones are never swept.
		expect(findZoneDescriptor(cleaned.state, challengeGuardianAngelZoneId('tenure-2'))?.cards).toEqual(['wands-v']);
		expectConserved(cleaned.state, catalog);
	});

	/** Sets up a `'turns'`-stage round with BOTH a `'pending'` Stun (recorded,
	 * never resolved) and an `'active'` Guardian Angel instance, then cleans
	 * up — the shared fixture for the two round-5 review tests below, which
	 * assert opposite outcomes for the SAME cleanup call: Stun's `'pending'`
	 * must expire, Guardian Angel's `'active'` must not (guard against
	 * over-broad expiry — the fix must be scoped to Stun, not every
	 * `'pending'`/`'active'` modifier alike). */
	function stunPendingAndGuardianAngelActive(seed: string) {
		const { state, gmCtx, p1Ctx } = readyTwoPlayerTurns(seed, ['wands-v'], ['pentacles-iv']);
		const ga = applyGuardianAngel(state, 'tenure-1', 'tenure-2', 'wands-v', guardianAngelParams, p1Ctx);
		if (!ga.ok) throw ga;
		const stunned = applyStun(ga.state, 'tenure-2', stunParams, gmCtx);
		if (!stunned.ok) throw stunned;
		expect(readChallengeState(stunned.state)?.modifiers).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ modifierId: CHALLENGE_GUARDIAN_ANGEL_ID, status: 'active' }),
				expect.objectContaining({ modifierId: CHALLENGE_STUN_ID, targetTenureId: 'tenure-2', status: 'pending' })
			])
		);

		const cleaned = cleanupRound(stunned.state, gmCtx);
		if (!cleaned.ok) throw cleaned;
		return cleaned.state;
	}

	it('an unresolved pending Stun expires at round cleanup (immediate: true — it does not bank indefinitely) and apply-stun is no longer offered to that target (review round 5)', () => {
		const seed = 'cleanup-stun-pending-expires';
		const cleanedState = stunPendingAndGuardianAngelActive(seed);

		const afterCleanup = readChallengeState(cleanedState)!;
		expect(afterCleanup.modifiers).not.toContainEqual(expect.objectContaining({ modifierId: CHALLENGE_STUN_ID }));
		expect(legalChallengeModifierCommands(cleanedState, playerActor('tenure-2'), derivationCaps)).not.toContain('apply-stun');
		expectConserved(cleanedState, catalog);
	});

	it("a Guardian Angel 'active' instance still survives the SAME cleanup (guard against over-broad expiry — review round 5)", () => {
		const seed = 'cleanup-guardian-angel-survives-alongside-stun';
		const cleanedState = stunPendingAndGuardianAngelActive(seed);

		const afterCleanup = readChallengeState(cleanedState)!;
		expect(afterCleanup.modifiers).toContainEqual(
			expect.objectContaining({ modifierId: CHALLENGE_GUARDIAN_ANGEL_ID, ownerTenureId: 'tenure-1', status: 'active' })
		);
		expect(findZoneDescriptor(cleanedState, challengeGuardianAngelZoneId('tenure-2'))?.cards).toEqual(['wands-v']);
		expectConserved(cleanedState, catalog);
	});

	// -------------------------------------------------------------------------
	// legalChallengeModifierCommands / applyChallengeModifierCommand (O4,
	// Important 1 — review): the actual derived command set, not just ownership
	// checks inside the individual apply* functions.
	// -------------------------------------------------------------------------

	describe('legalChallengeModifierCommands', () => {
		it("derives the GM's set from Challenge stage — Black Honey only during 'deal', Brainfever only during 'initiative-placement', Stun always", () => {
			const { state: dealState } = beginTwoPlayer('legal-gm-deal');
			expect(legalChallengeModifierCommands(dealState, GM, derivationCaps)).toEqual(
				expect.arrayContaining(['apply-black-honey', 'apply-stun'])
			);
			expect(legalChallengeModifierCommands(dealState, GM, derivationCaps)).not.toContain('apply-brainfever');

			const { state: placementState } = dealtTwoPlayer('legal-gm-placement');
			expect(legalChallengeModifierCommands(placementState, GM, derivationCaps)).toEqual(
				expect.arrayContaining(['apply-brainfever', 'apply-stun'])
			);
			expect(legalChallengeModifierCommands(placementState, GM, derivationCaps)).not.toContain('apply-black-honey');
		});

		it("derives a player's set from actor ownership + whose turn it is — the three own-turn actions are absent when it ISN'T their turn, Counsel is offered either way (\"any time during a Challenge\")", () => {
			const { state } = readyTwoPlayerTurns('legal-player-turn', ['wands-v'], ['pentacles-iv']);

			const tenure1Legal = legalChallengeModifierCommands(state, playerActor('tenure-1'), derivationCaps);
			expect(tenure1Legal).toEqual(
				expect.arrayContaining(['guardian-angel', 'aim-prepare', 'replace-initiative-with-shield', 'counsel-transfer'])
			);
			// Neither player has a pending Stun yet — apply-stun is not offered
			// to either (review round 4: it must be earned by a GM-recorded
			// pending instance, not offered unconditionally).
			expect(tenure1Legal).not.toContain('apply-stun');

			// tenure-2 is NOT the active seat — none of the own-turn actions are
			// offered to them, but Counsel ("any time during a Challenge") still is.
			const tenure2Legal = legalChallengeModifierCommands(state, playerActor('tenure-2'), derivationCaps);
			expect(tenure2Legal).toEqual(['counsel-transfer']);

			// The GM sees none of the player-only commands.
			expect(legalChallengeModifierCommands(state, GM, derivationCaps)).not.toEqual(
				expect.arrayContaining(['guardian-angel', 'aim-prepare', 'replace-initiative-with-shield', 'counsel-transfer'])
			);
		});

		it('offers apply-stun to the target ONLY once the GM has recorded a pending instance, and withdraws it again once resolved (review round 4)', () => {
			const { state, gmCtx, p2Ctx } = readyTwoPlayerTurns('legal-stun-pending', ['wands-v'], ['pentacles-iv']);
			expect(legalChallengeModifierCommands(state, playerActor('tenure-2'), derivationCaps)).not.toContain('apply-stun');

			const recorded = applyStun(state, 'tenure-2', stunParams, gmCtx);
			if (!recorded.ok) throw recorded;
			expect(legalChallengeModifierCommands(recorded.state, playerActor('tenure-2'), derivationCaps)).toContain('apply-stun');
			// tenure-1 is not the target — never offered it.
			expect(legalChallengeModifierCommands(recorded.state, playerActor('tenure-1'), derivationCaps)).not.toContain('apply-stun');

			const resolved = resolveStun(recorded.state, 'tenure-2', 'pentacles-iv', stunParams, p2Ctx);
			if (!resolved.ok) throw resolved;
			expect(legalChallengeModifierCommands(resolved.state, playerActor('tenure-2'), derivationCaps)).not.toContain('apply-stun');
		});

		it('excludes guardian-angel once the caster has an active instance (active content modifiers, the third O4 input)', () => {
			const { state, p1Ctx } = readyTwoPlayerTurns('legal-guardian-angel-cap', ['wands-v'], ['pentacles-iv']);
			expect(legalChallengeModifierCommands(state, playerActor('tenure-1'), derivationCaps)).toContain('guardian-angel');

			const cast = applyGuardianAngel(state, 'tenure-1', 'tenure-2', 'wands-v', guardianAngelParams, p1Ctx);
			if (!cast.ok) throw cast;
			expect(legalChallengeModifierCommands(cast.state, playerActor('tenure-1'), derivationCaps)).not.toContain('guardian-angel');
		});

		it('returns an empty set when no Challenge round is active', () => {
			expect(legalChallengeModifierCommands(makeSessionFixture('legal-no-round'), GM, derivationCaps)).toEqual([]);
		});

		it('excludes aim-prepare/replace-initiative-with-shield when the player lacks the equipment (round-2 review, Item 3 — equipment is a projection input)', () => {
			const { state } = readyTwoPlayerTurns('legal-equipment', ['wands-v'], ['pentacles-iv']);
			const bothMissing = { ...derivationCaps, hasBow: false, hasShield: false };
			const legal = legalChallengeModifierCommands(state, playerActor('tenure-1'), bothMissing);
			expect(legal).not.toContain('aim-prepare');
			expect(legal).not.toContain('replace-initiative-with-shield');
			// Guardian Angel needs neither, so it's still offered.
			expect(legal).toContain('guardian-angel');
		});

		it('excludes apply-black-honey once every participant has already eaten it this round (round-2 review, Item 3)', () => {
			const { state, gmCtx } = beginTwoPlayer('legal-black-honey-all-eaten');
			expect(legalChallengeModifierCommands(state, GM, derivationCaps)).toContain('apply-black-honey');

			const eaten1 = applyBlackHoney(state, 'tenure-1', blackHoneyParams, gmCtx);
			if (!eaten1.ok) throw eaten1;
			// Only tenure-1 has eaten — tenure-2 still could, so it's still offered.
			expect(legalChallengeModifierCommands(eaten1.state, GM, derivationCaps)).toContain('apply-black-honey');

			const eaten2 = applyBlackHoney(eaten1.state, 'tenure-2', blackHoneyParams, gmCtx);
			if (!eaten2.ok) throw eaten2;
			// Now EVERY participant has eaten — offering it again would always fail.
			expect(legalChallengeModifierCommands(eaten2.state, GM, derivationCaps)).not.toContain('apply-black-honey');
		});

		it("returns an empty set once the Challenge stage is 'complete' (round-2 review, Item 3 — apply-stun was previously offered here unconditionally)", () => {
			const { state } = readyTwoPlayerTurns('legal-complete-stage', ['wands-v'], ['pentacles-iv']);
			const challenge = readChallengeState(state)!;
			const completedState = writeChallengeState(state, { ...challenge, stage: 'complete' });

			expect(legalChallengeModifierCommands(completedState, GM, derivationCaps)).toEqual([]);
			expect(legalChallengeModifierCommands(completedState, playerActor('tenure-1'), derivationCaps)).toEqual([]);
		});
	});

	describe('applyChallengeModifierCommand — the mandated O4 test: a syntactically valid command absent from the derived set is rejected', () => {
		it("rejects Guard attempted by the actor whose turn it ISN'T — syntactically valid (well-formed tenure/card), never offered to tenure-2 right now", () => {
			const { state } = readyTwoPlayerTurns('dispatch-not-offered', ['pentacles-x'], ['pentacles-iv']);

			const result = applyChallengeModifierCommand(
				state,
				{ type: 'replace-initiative-with-shield', cardId: 'pentacles-iv' },
				materials,
				ctxFor(playerActor('tenure-2'), catalog, config, 'dispatch-not-offered')
			);
			expect(result).toMatchObject({
				ok: false,
				rejection: { code: 'illegal-command', message: expect.stringContaining('not currently offered') }
			});
		});

		it('dispatches an OFFERED command to the underlying mechanism and it actually succeeds', () => {
			const { state } = readyTwoPlayerTurns('dispatch-offered', ['pentacles-x'], ['pentacles-iv']);

			const result = applyChallengeModifierCommand(
				state,
				{ type: 'replace-initiative-with-shield', cardId: 'pentacles-x' },
				materials,
				ctxFor(playerActor('tenure-1'), catalog, config, 'dispatch-offered')
			);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(findZoneDescriptor(result.state, CHALLENGE_INITIATIVE_ZONE_ID)?.cards).toContain('pentacles-x');
			expectConserved(result.state, catalog);
		});

		it('rejects the GM attempting a player-only command (Brainfever is GM-only; guardian-angel is player-only) — absent from the GM\'s derived set', () => {
			const { state, gmCtx } = readyTwoPlayerTurns('dispatch-gm-not-offered', ['wands-v'], ['pentacles-iv']);
			const result = applyChallengeModifierCommand(
				state,
				{ type: 'guardian-angel', targetTenureId: 'tenure-2', cardId: 'wands-v' },
				materials,
				gmCtx
			);
			expect(result).toMatchObject({
				ok: false,
				rejection: { code: 'illegal-command', message: expect.stringContaining('not currently offered') }
			});
		});

		it('dispatches apply-stun to the matching function per actor role: GM records, target resolves (review round 4)', () => {
			const { state, gmCtx, p2Ctx } = readyTwoPlayerTurns('dispatch-stun-roundtrip', ['wands-v'], ['pentacles-iv']);

			const recorded = applyChallengeModifierCommand(state, { type: 'apply-stun', targetTenureId: 'tenure-2' }, materials, gmCtx);
			expect(recorded.ok).toBe(true);
			if (!recorded.ok) return;
			expect(recorded.events[0].kind).toBe('challenge-stun-inflicted');

			// Before it was recorded, the target's own resolve attempt would have
			// been rejected as not-offered (covered by the "no pending instance"
			// test on `resolveStun` directly); once recorded, tenure-1 (not the
			// target) still never sees it offered.
			expect(
				applyChallengeModifierCommand(recorded.state, { type: 'apply-stun', targetTenureId: 'tenure-1' }, materials, ctxFor(playerActor('tenure-1'), catalog, config, 'dispatch-stun-roundtrip'))
			).toMatchObject({ ok: false, rejection: { code: 'illegal-command', message: expect.stringContaining('not currently offered') } });

			const resolved = applyChallengeModifierCommand(
				recorded.state,
				{ type: 'apply-stun', targetTenureId: 'tenure-2', cardId: 'pentacles-iv' },
				materials,
				p2Ctx
			);
			expect(resolved.ok).toBe(true);
			if (!resolved.ok) return;
			expect(resolved.events[0].kind).toBe('challenge-stun-applied');
			expectConserved(resolved.state, catalog);
		});
	});
});
