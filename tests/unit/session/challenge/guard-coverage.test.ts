/**
 * Increment 3 Task 6 coverage follow-up. Running `--coverage` for the first
 * time on the Challenge engine (nothing in Tasks 1–4 ran it) surfaced a
 * cluster of never-exercised reject-path guards spread across those tasks'
 * modules — mostly "no active Challenge round" / "wrong stage" / "wrong
 * actor" branches every apply/resolve function checks but whose own
 * task's test suite happened not to hit. Each assertion below exercises a
 * REAL precondition against the REAL function (never a fabricated canary) to
 * close that gap — not new behavior, just the coverage those modules were
 * always supposed to have.
 */
import { describe, expect, it } from 'vitest';
import { getTarotProcedures } from '$lib/server/content/loader';
import { buildChallengeConfig } from '$lib/engine/session/procedures/challenge/schema';
import type { ChallengeConfig, ChallengeEnemyFact } from '$lib/engine/session/procedures/challenge/types';
import {
	beginChallenge,
	challengeHandZoneId,
	cleanupRound,
	readChallengeState,
	writeChallengeState,
	type ChallengeReduceContext
} from '$lib/engine/session/procedures/challenge/reducer';
import { dealRound } from '$lib/engine/session/procedures/challenge/deal';
import { placeGmInitiative, placeInitiative, revealInitiative } from '$lib/engine/session/procedures/challenge/initiative';
import { applyGmDiscard, applyGmMulligan, beginTurns, endTurn } from '$lib/engine/session/procedures/challenge/turns';
import {
	applyBlackHoney,
	applyBrainfever,
	applyGuard,
	applyGuardianAngel,
	applyStun,
	prepareAim,
	resolveAim,
	resolveGuardianAngel,
	resolveStun,
	findModifierParams,
	CHALLENGE_AIM_ID,
	CHALLENGE_BLACK_HONEY_ID,
	CHALLENGE_BRAINFEVER_ID,
	CHALLENGE_GUARD_ID,
	CHALLENGE_GUARDIAN_ANGEL_ID,
	CHALLENGE_STUN_ID
} from '$lib/engine/session/procedures/challenge/modifiers';
import { counselTransfer, CHALLENGE_COUNSEL_ID } from '$lib/engine/session/procedures/challenge/transfers';
import { makeRng } from '$lib/engine/rng';
import { makeRichSessionCatalogFixture, makeSessionFixture } from '../../../fixtures/session';
import type { SessionActor, TarotCardCatalog } from '$lib/types/session';
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
const ALICE: SessionActor = { kind: 'player', userId: 'user-alice' };

function ctxFor(actor: SessionActor, catalog: TarotCardCatalog, config: ChallengeConfig, seed: string): ChallengeReduceContext {
	return { actor, runtime: { catalog }, rng: makeRng(seed), config };
}

describe('Challenge guard-clause coverage (no active round / wrong stage / wrong actor)', () => {
	const catalog = makeRichSessionCatalogFixture();
	const { procedures, formulas, modifiers } = getTarotProcedures();
	const config = buildChallengeConfig(procedures, formulas);
	const blackHoneyParams = findModifierParams<OptionalHandSizeParams>(modifiers, CHALLENGE_BLACK_HONEY_ID, 'optional-hand-size');
	const stunParams = findModifierParams<ForcedHandDiscardParams>(modifiers, CHALLENGE_STUN_ID, 'forced-hand-discard');
	const brainfeverParams = findModifierParams<ForcedInitiativeSelectionParams>(modifiers, CHALLENGE_BRAINFEVER_ID, 'forced-initiative-selection');
	const guardianAngelParams = findModifierParams<GuardianAngelParams>(modifiers, CHALLENGE_GUARDIAN_ANGEL_ID, 'guardian-angel-defense');
	const aimParams = findModifierParams<PreparedFacedownBonusParams>(modifiers, CHALLENGE_AIM_ID, 'prepared-facedown-bonus');
	const guardParams = findModifierParams<ReplaceInitiativeParams>(modifiers, CHALLENGE_GUARD_ID, 'replace-initiative');
	const counselParams = findModifierParams<CounselTransferParams>(modifiers, CHALLENGE_COUNSEL_ID, 'private-transfer');

	const noRoundState = makeSessionFixture('guard-no-round');
	const gmCtx = ctxFor(GM, catalog, config, 'guard-no-round');
	const aliceCtx = ctxFor(ALICE, catalog, config, 'guard-no-round');

	it.each([
		['applyBlackHoney', () => applyBlackHoney(noRoundState, 'tenure-1', blackHoneyParams, gmCtx)],
		['applyStun', () => applyStun(noRoundState, 'tenure-1', stunParams, gmCtx)],
		['resolveStun', () => resolveStun(noRoundState, 'tenure-1', 'cups-i', stunParams, aliceCtx)],
		['applyBrainfever', () => applyBrainfever(noRoundState, 'tenure-1', brainfeverParams, gmCtx)],
		['resolveGuardianAngel', () => resolveGuardianAngel(noRoundState, 'tenure-1', 'cups-i', 'dodge', guardianAngelParams, gmCtx)],
		['resolveAim', () => resolveAim(noRoundState, 'tenure-1', 'cups-i', aimParams, gmCtx)],
		['counselTransfer', () => counselTransfer(noRoundState, 'user-bob', 'cups-i', counselParams, aliceCtx)],
		['placeInitiative', () => placeInitiative(noRoundState, 'tenure-1', 'cups-i', aliceCtx)],
		['placeGmInitiative', () => placeGmInitiative(noRoundState, 'ogre-1', 'cups-i', gmCtx)],
		['revealInitiative', () => revealInitiative(noRoundState, gmCtx)],
		['dealRound', () => dealRound(noRoundState, gmCtx)],
		['beginTurns', () => beginTurns(noRoundState, gmCtx)],
		['endTurn', () => endTurn(noRoundState, gmCtx)],
		['applyGmDiscard', () => applyGmDiscard(noRoundState, 'cups-i', gmCtx)],
		['applyGmMulligan', () => applyGmMulligan(noRoundState, gmCtx)],
		['cleanupRound', () => cleanupRound(noRoundState, gmCtx)]
	] as const)('%s rejects illegal-command with no active Challenge round', (_name, run) => {
		const result = run();
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.rejection.code).toBe('illegal-command');
	});

	it('applyGuardianAngel rejects with no active Challenge round (via requirePlayerTurn)', () => {
		const result = applyGuardianAngel(noRoundState, 'tenure-1', 'tenure-2', 'cups-i', guardianAngelParams, aliceCtx);
		expect(result.ok).toBe(false);
	});

	it('prepareAim rejects with no active Challenge round (via requirePlayerTurn)', () => {
		const result = prepareAim(noRoundState, 'tenure-1', 'cups-i', true, aimParams, aliceCtx);
		expect(result.ok).toBe(false);
	});

	it('applyGuard rejects with no active Challenge round (via requirePlayerTurn)', () => {
		const result = applyGuard(noRoundState, 'tenure-1', 'cups-i', true, guardParams, aliceCtx);
		expect(result.ok).toBe(false);
	});

	it('placeInitiative rejects during the wrong stage', () => {
		const seed = 'guard-wrong-stage';
		const state = makeSessionFixture(seed);
		const ctx = ctxFor(GM, catalog, config, seed);
		const begun = beginChallenge(state, { participantTenureIds: ['tenure-1'], tenureOwners: { 'tenure-1': 'user-alice' }, enemyFacts: [] }, ctx);
		if (!begun.ok) throw begun;
		// Still `stage: 'deal'` — Initiative placement isn't legal yet.
		const result = placeInitiative(begun.state, 'tenure-1', 'cups-i', ctxFor(ALICE, catalog, config, seed));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.rejection.message).toMatch(/stage/);
	});

	it('placeInitiative rejects for a tenure that is not an active participant', () => {
		const seed = 'guard-not-participant';
		const state = makeSessionFixture(seed);
		const ctx = ctxFor(GM, catalog, config, seed);
		const begun = beginChallenge(state, { participantTenureIds: ['tenure-1'], tenureOwners: { 'tenure-1': 'user-alice' }, enemyFacts: [] }, ctx);
		if (!begun.ok) throw begun;
		const dealt = dealRound(begun.state, ctx);
		if (!dealt.ok) throw dealt;
		const result = placeInitiative(dealt.state, 'tenure-not-in-round', 'cups-i', ctxFor(ALICE, catalog, config, seed));
		expect(result.ok).toBe(false);
	});

	it('revealInitiative rejects to a non-GM actor', () => {
		const seed = 'guard-reveal-not-gm';
		const state = makeSessionFixture(seed);
		const ctx = ctxFor(GM, catalog, config, seed);
		const begun = beginChallenge(state, { participantTenureIds: ['tenure-1'], tenureOwners: { 'tenure-1': 'user-alice' }, enemyFacts: [] }, ctx);
		if (!begun.ok) throw begun;
		const result = revealInitiative(begun.state, ctxFor(ALICE, catalog, config, seed));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.rejection.code).toBe('not-authorized');
	});

	it('beginTurns rejects to a non-GM actor, and rejects an empty Initiative order', () => {
		const seed = 'guard-begin-turns';
		const state = makeSessionFixture(seed);
		const ctx = ctxFor(GM, catalog, config, seed);
		const begun = beginChallenge(state, { participantTenureIds: ['tenure-1'], tenureOwners: { 'tenure-1': 'user-alice' }, enemyFacts: [] }, ctx);
		if (!begun.ok) throw begun;
		const notGm = beginTurns(begun.state, ctxFor(ALICE, catalog, config, seed));
		expect(notGm.ok).toBe(false);
		if (!notGm.ok) expect(notGm.rejection.code).toBe('not-authorized');

		const dealt = dealRound(begun.state, ctx);
		if (!dealt.ok) throw dealt;
		// Wrong stage (`deal`, not `initiative-reveal`) — never placed/revealed.
		const wrongStage = beginTurns(dealt.state, ctx);
		expect(wrongStage.ok).toBe(false);
	});

	it('endTurn rejects during the wrong stage and when turns have not begun', () => {
		const seed = 'guard-end-turn';
		const state = makeSessionFixture(seed);
		const ctx = ctxFor(GM, catalog, config, seed);
		const begun = beginChallenge(state, { participantTenureIds: ['tenure-1'], tenureOwners: { 'tenure-1': 'user-alice' }, enemyFacts: [] }, ctx);
		if (!begun.ok) throw begun;
		// Still `stage: 'deal'`.
		const result = endTurn(begun.state, ctx);
		expect(result.ok).toBe(false);
	});

	it('applyGmDiscard rejects to a non-GM actor, and during the wrong stage', () => {
		const seed = 'guard-gm-discard';
		const state = makeSessionFixture(seed);
		const ctx = ctxFor(GM, catalog, config, seed);
		const begun = beginChallenge(state, { participantTenureIds: ['tenure-1'], tenureOwners: { 'tenure-1': 'user-alice' }, enemyFacts: [] }, ctx);
		if (!begun.ok) throw begun;
		const notGm = applyGmDiscard(begun.state, 'the-fool', ctxFor(ALICE, catalog, config, seed));
		expect(notGm.ok).toBe(false);
		if (!notGm.ok) expect(notGm.rejection.code).toBe('not-authorized');

		const wrongStage = applyGmDiscard(begun.state, 'the-fool', ctx);
		expect(wrongStage.ok).toBe(false);
	});

	it('applyGmMulligan rejects to a non-GM actor, and during the wrong stage', () => {
		const seed = 'guard-gm-mulligan';
		const state = makeSessionFixture(seed);
		const ctx = ctxFor(GM, catalog, config, seed);
		const begun = beginChallenge(state, { participantTenureIds: ['tenure-1'], tenureOwners: { 'tenure-1': 'user-alice' }, enemyFacts: [] }, ctx);
		if (!begun.ok) throw begun;
		const notGm = applyGmMulligan(begun.state, ctxFor(ALICE, catalog, config, seed));
		expect(notGm.ok).toBe(false);
		if (!notGm.ok) expect(notGm.rejection.code).toBe('not-authorized');

		const wrongStage = applyGmMulligan(begun.state, ctx);
		expect(wrongStage.ok).toBe(false);
	});

	it('placeGmInitiative rejects to a non-GM actor and for an unrecognized enemyFactId', () => {
		const seed = 'guard-gm-initiative';
		const state = makeSessionFixture(seed);
		const ctx = ctxFor(GM, catalog, config, seed);
		const enemyFacts: ChallengeEnemyFact[] = [{ id: 'ogre-1', size: 'human', threat: 'minion', typeIds: ['ogre'], count: 1 }];
		const begun = beginChallenge(state, { participantTenureIds: ['tenure-1'], tenureOwners: { 'tenure-1': 'user-alice' }, enemyFacts }, ctx);
		if (!begun.ok) throw begun;
		const dealt = dealRound(begun.state, ctx);
		if (!dealt.ok) throw dealt;

		const notGm = placeGmInitiative(dealt.state, 'ogre-1', 'the-fool', ctxFor(ALICE, catalog, config, seed));
		expect(notGm.ok).toBe(false);
		if (!notGm.ok) expect(notGm.rejection.code).toBe('not-authorized');

		const unknownEnemy = placeGmInitiative(dealt.state, 'not-a-real-enemy', 'the-fool', ctx);
		expect(unknownEnemy.ok).toBe(false);
	});

	it('beginChallenge rejects an empty participant roster', () => {
		const seed = 'guard-empty-roster';
		const state = makeSessionFixture(seed);
		const ctx = ctxFor(GM, catalog, config, seed);
		const result = beginChallenge(state, { participantTenureIds: [], tenureOwners: {}, enemyFacts: [] }, ctx);
		expect(result.ok).toBe(false);
	});

	it('beginChallenge rejects a second attempt while a procedure is already active', () => {
		const seed = 'guard-already-active';
		const state = makeSessionFixture(seed);
		const ctx = ctxFor(GM, catalog, config, seed);
		const begun = beginChallenge(state, { participantTenureIds: ['tenure-1'], tenureOwners: { 'tenure-1': 'user-alice' }, enemyFacts: [] }, ctx);
		if (!begun.ok) throw begun;
		const second = beginChallenge(begun.state, { participantTenureIds: ['tenure-2'], tenureOwners: { 'tenure-2': 'user-bob' }, enemyFacts: [] }, ctx);
		expect(second.ok).toBe(false);
	});

	it('readChallengeState returns undefined for a corrupted gmPrivate blob rather than throwing', () => {
		const seed = 'guard-corrupt-state';
		const state = makeSessionFixture(seed);
		const corrupted = { ...state, procedure: { procedureId: 'challenge-round', stepIndex: 0, pendingZoneIds: [], gmPrivate: { not: 'valid' } } };
		expect(readChallengeState(corrupted)).toBeUndefined();
	});

	it('writeChallengeState throws when no procedure is active (a reducer bug, not a rejectable user error)', () => {
		const seed = 'guard-write-no-procedure';
		const state = makeSessionFixture(seed);
		expect(() =>
			writeChallengeState(state, {
				schemaVersion: 1,
				stage: 'deal',
				round: 1,
				participantTenureIds: [],
				tenureOwners: {},
				pendingJoinTenureIds: [],
				enemyFacts: [],
				initiativeOrder: [],
				tiedGroups: [],
				activeTurnIndex: null,
				turnKind: null,
				budgets: {},
				mulliganUsedThisRound: false,
				modifiers: []
			})
		).toThrow();
	});
});
