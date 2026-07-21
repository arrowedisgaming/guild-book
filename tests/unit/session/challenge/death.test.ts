/**
 * Death and legal replacement joins (Increment 3 Task 5) — the pure,
 * engine-layer half of the brief's binding overrides: `markTenureDead`'s
 * bookkeeping (zone redaction, participant/budget/initiative/tied-group/
 * modifier cleanup, card conservation) and `admitPendingJoinTenure`'s
 * boundary-only admission (O3). The character-life/tenure-ended/atomicity
 * half is `tests/integration/challenge-death.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { getTarotProcedures } from '$lib/server/content/loader';
import { buildChallengeConfig } from '$lib/engine/session/procedures/challenge/schema';
import type { ChallengeConfig, ChallengeEnemyFact } from '$lib/engine/session/procedures/challenge/types';
import {
	admitPendingJoinTenure,
	beginChallenge,
	challengeHandZoneId,
	challengeInitiativeFacedownZoneId,
	CHALLENGE_INITIATIVE_ZONE_ID,
	cleanupRound,
	markTenureDead,
	readChallengeState,
	type ChallengeReduceContext
} from '$lib/engine/session/procedures/challenge/reducer';
import { dealRound } from '$lib/engine/session/procedures/challenge/deal';
import { placeInitiative, revealInitiative } from '$lib/engine/session/procedures/challenge/initiative';
import { beginTurns, endTurn } from '$lib/engine/session/procedures/challenge/turns';
import { assertSessionInvariants } from '$lib/engine/session/invariants';
import { findZoneDescriptor } from '$lib/engine/session/state';
import { makeRng } from '$lib/engine/rng';
import { makeRichSessionCatalogFixture, makeSessionFixture } from '../../../fixtures/session';
import type { SessionActor, SessionEngineStateV1, TarotCardCatalog } from '$lib/types/session';

const GM: SessionActor = { kind: 'gm', userId: 'gm-1' };
const TENURE_IDS = ['tenure-1', 'tenure-2'];
const TENURE_OWNERS: Record<string, string> = { 'tenure-1': 'user-alice', 'tenure-2': 'user-bob' };

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

const noEnemies: ChallengeEnemyFact[] = [];

describe('markTenureDead', () => {
	const catalog = makeRichSessionCatalogFixture();
	const { procedures, formulas } = getTarotProcedures();
	const config = buildChallengeConfig(procedures, formulas);

	function dealtState(seed: string): SessionEngineStateV1 {
		const state = makeSessionFixture(seed);
		const begun = beginChallenge(
			state,
			{ participantTenureIds: TENURE_IDS, tenureOwners: TENURE_OWNERS, enemyFacts: noEnemies },
			ctxFor(GM, catalog, config, seed)
		);
		if (!begun.ok) throw begun;
		const dealt = dealRound(begun.state, ctxFor(GM, catalog, config, seed));
		if (!dealt.ok) throw dealt;
		return dealt.state;
	}

	it('rejects when no Challenge round is active', () => {
		const state = makeSessionFixture('no-challenge');
		const result = markTenureDead(state, 'tenure-1', ctxFor(GM, catalog, config, 'no-challenge'));
		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});

	it('rejects a tenureId that is not an active participant — distinct from every other guard here', () => {
		const state = dealtState('not-participant');
		const result = markTenureDead(state, 'tenure-nonexistent', ctxFor(GM, catalog, config, 'not-participant'));
		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command', message: expect.stringContaining('tenure-nonexistent') } });
	});

	it("rejects a player marking a DIFFERENT tenure's owner dead", () => {
		const state = dealtState('wrong-owner');
		const result = markTenureDead(state, 'tenure-1', ctxFor(playerActor('tenure-2'), catalog, config, 'wrong-owner'));
		expect(result).toMatchObject({ ok: false, rejection: { code: 'not-authorized' } });
	});

	it('allows a player to mark their OWN tenure dead', () => {
		const state = dealtState('own-death');
		const result = markTenureDead(state, 'tenure-1', ctxFor(playerActor('tenure-1'), catalog, config, 'own-death'));
		expect(result.ok).toBe(true);
	});

	it('allows the GM to mark any tenure dead', () => {
		const state = dealtState('gm-death');
		const result = markTenureDead(state, 'tenure-1', ctxFor(GM, catalog, config, 'gm-death'));
		expect(result.ok).toBe(true);
	});

	it('discards every card from the dying tenure\'s hand to the player discard pile, and removes the zone entirely', () => {
		const state = dealtState('hand-discard');
		const handBefore = findZoneDescriptor(state, challengeHandZoneId('tenure-1'));
		expect(handBefore?.cards.length).toBeGreaterThan(0);
		const cardsHeld = handBefore!.cards.slice();

		const result = markTenureDead(state, 'tenure-1', ctxFor(GM, catalog, config, 'hand-discard'));
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(findZoneDescriptor(result.state, challengeHandZoneId('tenure-1'))).toBeUndefined();
		for (const cardId of cardsHeld) {
			expect(result.state.playerDiscard).toContain(cardId);
		}
		expectConserved(result.state, catalog);
	});

	it('removes the tenure from participantTenureIds and budgets, and leaves the sibling tenure completely untouched (no partial death)', () => {
		const state = dealtState('sibling-untouched');
		const siblingHandBefore = findZoneDescriptor(state, challengeHandZoneId('tenure-2'))!.cards.slice();

		const result = markTenureDead(state, 'tenure-1', ctxFor(GM, catalog, config, 'sibling-untouched'));
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const challenge = readChallengeState(result.state)!;
		expect(challenge.participantTenureIds).toEqual(['tenure-2']);
		expect(challenge.budgets['tenure-1']).toBeUndefined();
		expect(challenge.budgets['tenure-2']).toBeDefined();

		const siblingHandAfter = findZoneDescriptor(result.state, challengeHandZoneId('tenure-2'))!.cards;
		expect(siblingHandAfter).toEqual(siblingHandBefore);
	});

	it('emits a public challenge-participant-died event naming the tenure and round', () => {
		const state = dealtState('event');
		const result = markTenureDead(state, 'tenure-1', ctxFor(GM, catalog, config, 'event'));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.events.at(-1)).toEqual({
			kind: 'challenge-participant-died',
			publicPayload: { tenureId: 'tenure-1', round: 1 }
		});
	});

	it('discards an UNREVEALED placed Initiative card and removes it from initiativeOrder', () => {
		const state = dealtState('unrevealed-initiative');
		const hand = findZoneDescriptor(state, challengeHandZoneId('tenure-1'))!;
		const placed = placeInitiative(state, 'tenure-1', hand.cards[0], ctxFor(playerActor('tenure-1'), catalog, config, 'unrevealed-initiative'));
		if (!placed.ok) throw placed;
		expect(findZoneDescriptor(placed.state, challengeInitiativeFacedownZoneId('tenure-1'))?.cards.length).toBe(1);

		const result = markTenureDead(placed.state, 'tenure-1', ctxFor(GM, catalog, config, 'unrevealed-initiative'));
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(findZoneDescriptor(result.state, challengeInitiativeFacedownZoneId('tenure-1'))).toBeUndefined();
		expect(readChallengeState(result.state)!.initiativeOrder.some((entry) => entry.tenureId === 'tenure-1')).toBe(false);
		expectConserved(result.state, catalog);
	});

	it('discards a REVEALED Initiative card from the shared public zone by id, without touching the sibling\'s revealed card', () => {
		const state = dealtState('revealed-initiative');
		const handA = findZoneDescriptor(state, challengeHandZoneId('tenure-1'))!;
		const placedA = placeInitiative(state, 'tenure-1', handA.cards[0], ctxFor(playerActor('tenure-1'), catalog, config, 'revealed-initiative'));
		if (!placedA.ok) throw placedA;
		const handB = findZoneDescriptor(placedA.state, challengeHandZoneId('tenure-2'))!;
		const placedB = placeInitiative(placedA.state, 'tenure-2', handB.cards[0], ctxFor(playerActor('tenure-2'), catalog, config, 'revealed-initiative'));
		if (!placedB.ok) throw placedB;
		const revealed = revealInitiative(placedB.state, ctxFor(GM, catalog, config, 'revealed-initiative'));
		if (!revealed.ok) throw revealed;

		const challengeBefore = readChallengeState(revealed.state)!;
		const entryA = challengeBefore.initiativeOrder.find((e) => e.tenureId === 'tenure-1')!;
		const entryB = challengeBefore.initiativeOrder.find((e) => e.tenureId === 'tenure-2')!;
		expect(entryA.revealed).toBe(true);
		expect(findZoneDescriptor(revealed.state, CHALLENGE_INITIATIVE_ZONE_ID)?.cards).toEqual(
			expect.arrayContaining([entryA.cardId, entryB.cardId])
		);

		const result = markTenureDead(revealed.state, 'tenure-1', ctxFor(GM, catalog, config, 'revealed-initiative'));
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const sharedZone = findZoneDescriptor(result.state, CHALLENGE_INITIATIVE_ZONE_ID)!;
		expect(sharedZone.cards).not.toContain(entryA.cardId);
		expect(sharedZone.cards).toContain(entryB.cardId); // sibling's revealed card is untouched
		expect(result.state.playerDiscard).toContain(entryA.cardId);
		expect(readChallengeState(result.state)!.initiativeOrder.map((e) => e.tenureId)).toEqual(['tenure-2']);
		expectConserved(result.state, catalog);
	});

	it('rejects marking the tenure whose turn is currently active dead — the GM must end the turn first', () => {
		const state = dealtState('active-turn');
		const handA = findZoneDescriptor(state, challengeHandZoneId('tenure-1'))!;
		const placedA = placeInitiative(state, 'tenure-1', handA.cards[0], ctxFor(playerActor('tenure-1'), catalog, config, 'active-turn'));
		if (!placedA.ok) throw placedA;
		const handB = findZoneDescriptor(placedA.state, challengeHandZoneId('tenure-2'))!;
		const placedB = placeInitiative(placedA.state, 'tenure-2', handB.cards[0], ctxFor(playerActor('tenure-2'), catalog, config, 'active-turn'));
		if (!placedB.ok) throw placedB;
		const revealed = revealInitiative(placedB.state, ctxFor(GM, catalog, config, 'active-turn'));
		if (!revealed.ok) throw revealed;
		const started = beginTurns(revealed.state, ctxFor(GM, catalog, config, 'active-turn'));
		if (!started.ok) throw started;

		const challenge = readChallengeState(started.state)!;
		const activeTenureId = challenge.initiativeOrder[challenge.activeTurnIndex!].tenureId;

		const result = markTenureDead(started.state, activeTenureId, ctxFor(GM, catalog, config, 'active-turn'));
		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });

		// Discrimination: the OTHER (non-active) tenure can still be marked
		// dead in the exact same state — proving this is genuinely the
		// active-turn guard, not some other coincidental rejection.
		const otherTenureId = TENURE_IDS.find((id) => id !== activeTenureId)!;
		const otherResult = markTenureDead(started.state, otherTenureId, ctxFor(GM, catalog, config, 'active-turn'));
		expect(otherResult.ok).toBe(true);

		// After ending the active turn, the previously-active tenure CAN be
		// marked dead.
		const ended = endTurn(started.state, ctxFor(GM, catalog, config, 'active-turn'));
		if (!ended.ok) throw ended;
		const afterEnd = markTenureDead(ended.state, activeTenureId, ctxFor(GM, catalog, config, 'active-turn'));
		expect(afterEnd.ok).toBe(true);
	});
});

describe('admitPendingJoinTenure — boundary-only admission (O3)', () => {
	const catalog = makeRichSessionCatalogFixture();
	const { procedures, formulas } = getTarotProcedures();
	const config = buildChallengeConfig(procedures, formulas);

	it('is a no-op (same state reference) outside an active Challenge round', () => {
		const state = makeSessionFixture('no-challenge-join');
		const result = admitPendingJoinTenure(state, 'tenure-5', catalog);
		expect(result).toEqual({ ok: true, state, events: [] });
	});

	it('appends a new tenureId to pendingJoinTenureIds without touching participantTenureIds', () => {
		const state = makeSessionFixture('join');
		const begun = beginChallenge(
			state,
			{ participantTenureIds: TENURE_IDS, tenureOwners: TENURE_OWNERS, enemyFacts: noEnemies },
			ctxFor(GM, catalog, config, 'join')
		);
		if (!begun.ok) throw begun;

		const result = admitPendingJoinTenure(begun.state, 'tenure-5', catalog);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const challenge = readChallengeState(result.state)!;
		expect(challenge.pendingJoinTenureIds).toEqual(['tenure-5']);
		expect(challenge.participantTenureIds).toEqual(TENURE_IDS);
	});

	it('is idempotent — a tenureId already pending or already active is not duplicated', () => {
		const state = makeSessionFixture('idempotent-join');
		const begun = beginChallenge(
			state,
			{ participantTenureIds: TENURE_IDS, tenureOwners: TENURE_OWNERS, enemyFacts: noEnemies },
			ctxFor(GM, catalog, config, 'idempotent-join')
		);
		if (!begun.ok) throw begun;

		const first = admitPendingJoinTenure(begun.state, 'tenure-5', catalog);
		if (!first.ok) throw first;
		const second = admitPendingJoinTenure(first.state, 'tenure-5', catalog);
		expect(second).toEqual({ ok: true, state: first.state, events: [] });

		const alreadyActive = admitPendingJoinTenure(first.state, 'tenure-1', catalog);
		expect(alreadyActive).toEqual({ ok: true, state: first.state, events: [] });
	});

	it('BOUNDARY: a pending joiner gets no hand and no private zone at the next deal — only after cleanupRound admits it does a following deal reach it', () => {
		const state = makeSessionFixture('boundary');
		const begun = beginChallenge(
			state,
			{ participantTenureIds: TENURE_IDS, tenureOwners: TENURE_OWNERS, enemyFacts: noEnemies },
			ctxFor(GM, catalog, config, 'boundary')
		);
		if (!begun.ok) throw begun;

		const joined = admitPendingJoinTenure(begun.state, 'tenure-5', catalog);
		if (!joined.ok) throw joined;

		// Current round's own deal (still stage 'deal', unaffected by the
		// pending join) must NOT deal to the pending tenure, and must NOT
		// create its private hand zone at all.
		const dealt = dealRound(joined.state, ctxFor(GM, catalog, config, 'boundary'));
		if (!dealt.ok) throw dealt;
		expect(findZoneDescriptor(dealt.state, challengeHandZoneId('tenure-5'))).toBeUndefined();
		expect(readChallengeState(dealt.state)!.participantTenureIds).toEqual(TENURE_IDS);

		// Advance far enough to legally clean up the round (Task 2's
		// cleanupRound is callable from 'initiative-reveal' onward).
		const handA = findZoneDescriptor(dealt.state, challengeHandZoneId('tenure-1'))!;
		const placedA = placeInitiative(dealt.state, 'tenure-1', handA.cards[0], ctxFor(playerActor('tenure-1'), catalog, config, 'boundary'));
		if (!placedA.ok) throw placedA;
		const handB = findZoneDescriptor(placedA.state, challengeHandZoneId('tenure-2'))!;
		const placedB = placeInitiative(placedA.state, 'tenure-2', handB.cards[0], ctxFor(playerActor('tenure-2'), catalog, config, 'boundary'));
		if (!placedB.ok) throw placedB;
		const revealed = revealInitiative(placedB.state, ctxFor(GM, catalog, config, 'boundary'));
		if (!revealed.ok) throw revealed;

		// cleanupRound (Task 2, composed with — not reimplemented, O3) admits
		// the pending join and registers its owner.
		const cleaned = cleanupRound(revealed.state, ctxFor(GM, catalog, config, 'boundary'), {
			tenureOwners: { 'tenure-5': 'user-eve' }
		});
		if (!cleaned.ok) throw cleaned;
		const challengeAfterCleanup = readChallengeState(cleaned.state)!;
		expect(challengeAfterCleanup.participantTenureIds).toEqual([...TENURE_IDS, 'tenure-5']);
		expect(challengeAfterCleanup.pendingJoinTenureIds).toEqual([]);
		// Zone provisioning happens AT admission (matching `ensureParticipantZones`'s
		// existing idempotent-creation behavior — Task 2), but no hand is DEALT
		// yet: dealing is always a SEPARATE, subsequent `dealRound` call, exactly
		// like every other round's own two-step shape.
		expect(findZoneDescriptor(cleaned.state, challengeHandZoneId('tenure-5'))?.cards).toEqual([]);

		const dealtNextRound = dealRound(cleaned.state, ctxFor(GM, catalog, config, 'boundary'));
		if (!dealtNextRound.ok) throw dealtNextRound;
		expect(findZoneDescriptor(dealtNextRound.state, challengeHandZoneId('tenure-5'))!.cards.length).toBeGreaterThan(0);
		expectConserved(dealtNextRound.state, catalog);
	});
});
