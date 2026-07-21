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
import { beginTurns } from '$lib/engine/session/procedures/challenge/turns';
import {
	applyBlackHoney,
	applyBrainfever,
	applyGuard,
	applyGuardianAngel,
	applyStun,
	findModifierParams,
	prepareAim,
	resolveAim,
	CHALLENGE_AIM_ID,
	CHALLENGE_BLACK_HONEY_ID,
	CHALLENGE_BRAINFEVER_ID,
	CHALLENGE_GUARD_ID,
	CHALLENGE_GUARDIAN_ANGEL_ID,
	CHALLENGE_STUN_ID
} from '$lib/engine/session/procedures/challenge/modifiers';
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

	it('every modifier lookup narrows to its expected params shape (content-integrity guard)', () => {
		expect(blackHoneyParams).toEqual({ normalCards: 4, optionalCards: 5, teethLostFrom: 1, teethLostTo: 4 });
		expect(stunParams).toEqual({ immediate: true, discard: 'entire-hand' });
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

	describe('applyStun', () => {
		it('immediately discards the affected eligible hand cards and emits a public COUNT, not identities that were not otherwise public (Step 1 / O3)', () => {
			const { state, gmCtx } = readyTwoPlayerTurns('stun-basic', ['swords-vii', 'cups-ii'], ['pentacles-iv', 'cups-iii']);
			const hand2Before = findZoneDescriptor(state, challengeHandZoneId('tenure-2'))!.cards.slice();
			expect(hand2Before.length).toBeGreaterThan(0);

			const result = applyStun(state, 'tenure-2', stunParams, gmCtx);
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			expect(findZoneDescriptor(result.state, challengeHandZoneId('tenure-2'))?.cards).toEqual([]);
			expect(result.events).toHaveLength(1);
			expect(result.events[0]).toMatchObject({
				kind: 'challenge-stun-applied',
				publicPayload: { targetTenureId: 'tenure-2', count: hand2Before.length }
			});
			// Canary: none of the discarded cards' identities leaked into the
			// public payload, even though they DID land in a public-top discard
			// pile (the underlying per-card discards are never surfaced as
			// separate events here — see `modifiers.ts`'s doc comment).
			const serializedPublic = JSON.stringify(result.events[0].publicPayload);
			for (const cardId of hand2Before) expect(serializedPublic).not.toContain(cardId);
			expect(result.events[0].privatePayloads).toBeUndefined();

			expectConserved(result.state, catalog);
		});

		it('rejects a non-GM actor', () => {
			const { state } = readyTwoPlayerTurns('stun-not-gm', ['swords-vii'], ['pentacles-iv']);
			const result = applyStun(state, 'tenure-2', stunParams, ctxFor(playerActor('tenure-1'), catalog, config, 'stun-not-gm'));
			expect(result).toMatchObject({ ok: false, rejection: { code: 'not-authorized' } });
		});

		it('rejects the wrong stage distinctly from the authorization guard (test discrimination)', () => {
			const { state, gmCtx } = dealtTwoPlayer('stun-wrong-stage');
			const result = applyStun(state, 'tenure-1', stunParams, gmCtx);
			expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command', message: expect.stringContaining('stage') } });
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

		it('rejects casting a second Guardian Angel while the caster already has an active one (maxInstances: 1)', () => {
			const { state, p1Ctx } = readyTwoPlayerTurns('guardian-angel-cap', ['wands-v', 'cups-ii'], ['pentacles-iv']);
			const first = applyGuardianAngel(state, 'tenure-1', 'tenure-2', 'wands-v', guardianAngelParams, p1Ctx);
			if (!first.ok) throw first;

			// The `maxInstances` cap check runs BEFORE `spendCard`'s own budget
			// cap, so this proves the maxInstances guard fires on its own — even
			// though the per-turn card budget is also already exhausted after
			// the first cast, this rejection is not that one (see the message
			// assertion below).
			const second = applyGuardianAngel(first.state, 'tenure-1', 'tenure-2', 'cups-ii', guardianAngelParams, p1Ctx);
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
});
