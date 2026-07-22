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
	challengeGuardianAngelZoneId,
	challengeHandZoneId,
	challengeInitiativeFacedownZoneId,
	CHALLENGE_GUARDIAN_ANGEL_ID,
	CHALLENGE_INITIATIVE_ZONE_ID,
	cleanupRound,
	markTenureDead,
	readChallengeState,
	writeChallengeState,
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

	// Branch-fix I10: a ward the dying tenure CAST onto another player must be
	// swept, or the card is stranded in the target's zone (unresolvable, since
	// the instance is dropped, and never conserved to a discard pile).
	it('sweeps Guardian Angel wards the dying caster placed on OTHER players (I10)', () => {
		const state = dealtState('i10-cast-ward');
		const handA = findZoneDescriptor(state, challengeHandZoneId('tenure-1'))!;
		const wardCard = handA.cards[0];
		const challenge = readChallengeState(state)!;

		// Plant an active ward tenure-1 cast onto tenure-2 (equivalent to a real
		// cast, without threading a full own-turn sequence): move the card from
		// tenure-1's hand into tenure-2's ward zone and register the instance.
		const wardZoneId = challengeGuardianAngelZoneId('tenure-2');
		const withZones: SessionEngineStateV1 = {
			...state,
			privateZones: state.privateZones
				.map((zone) => (zone.id === challengeHandZoneId('tenure-1') ? { ...zone, cards: zone.cards.filter((id) => id !== wardCard) } : zone))
				.concat({ id: wardZoneId, kind: 'player-facedown', ownerUserId: ownerOf('tenure-2'), cards: [wardCard] })
		};
		const withWard = writeChallengeState(withZones, {
			...challenge,
			modifiers: challenge.modifiers.concat({
				instanceId: `${CHALLENGE_GUARDIAN_ANGEL_ID}:tenure-1:1:0`,
				modifierId: CHALLENGE_GUARDIAN_ANGEL_ID,
				ownerTenureId: 'tenure-1',
				targetTenureId: 'tenure-2',
				status: 'active',
				cardId: wardCard
			})
		});
		expectConserved(withWard, catalog);

		const result = markTenureDead(withWard, 'tenure-1', ctxFor(GM, catalog, config, 'i10-cast-ward'));
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		// The warded card was conserved to the player discard pile, not left
		// stranded in tenure-2's (still-live) ward zone.
		expect(result.state.playerDiscard).toContain(wardCard);
		expect(findZoneDescriptor(result.state, wardZoneId)?.cards ?? []).not.toContain(wardCard);
		// The dropped instance and the swept card agree — no active ward owned by
		// the dead caster remains.
		expect(readChallengeState(result.state)!.modifiers.some((m) => m.ownerTenureId === 'tenure-1')).toBe(false);
		expectConserved(result.state, catalog);
	});

	// Review Minor 6: unbounded growth / stale authorization edge otherwise.
	it('prunes the dead tenure\'s tenureOwners entry', () => {
		const state = dealtState('prune-owners');
		const result = markTenureDead(state, 'tenure-1', ctxFor(GM, catalog, config, 'prune-owners'));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const challenge = readChallengeState(result.state)!;
		expect(challenge.tenureOwners).toEqual({ 'tenure-2': 'user-bob' });
	});

	// Review Minor 8: death of the LAST remaining participant must not corrupt
	// state — verify cleanupRound/dealRound stay sane against an empty roster.
	it('handles death of the last remaining participant — cleanupRound and dealRound both stay sane on an empty roster', () => {
		const state = dealtState('last-participant');
		const firstDeath = markTenureDead(state, 'tenure-1', ctxFor(GM, catalog, config, 'last-participant'));
		if (!firstDeath.ok) throw firstDeath;
		const secondDeath = markTenureDead(firstDeath.state, 'tenure-2', ctxFor(GM, catalog, config, 'last-participant'));
		expect(secondDeath.ok).toBe(true);
		if (!secondDeath.ok) return;

		const challenge = readChallengeState(secondDeath.state)!;
		expect(challenge.participantTenureIds).toEqual([]);
		expect(challenge.tenureOwners).toEqual({});
		expect(challenge.budgets).toEqual({ gm: expect.any(Object) });
		expectConserved(secondDeath.state, catalog);

		// cleanupRound requires stage 'initiative-reveal' or later — reachable
		// even with an empty roster since revealInitiative's "everyone has
		// placed" check is vacuously true when there is no one left to place.
		const revealed = revealInitiative(secondDeath.state, ctxFor(GM, catalog, config, 'last-participant'));
		expect(revealed.ok).toBe(true);
		if (!revealed.ok) return;

		// cleanupRound must not crash on an empty roster.
		const cleaned = cleanupRound(revealed.state, ctxFor(GM, catalog, config, 'last-participant'));
		expect(cleaned.ok).toBe(true);
		if (!cleaned.ok) return;
		expect(readChallengeState(cleaned.state)!.participantTenureIds).toEqual([]);
		expectConserved(cleaned.state, catalog);

		// dealRound must not crash on an empty roster either — zero player
		// hands dealt, GM hand recalculated from (now zero) enemyFacts/
		// adventurerCount.
		const dealtAgain = dealRound(cleaned.state, ctxFor(GM, catalog, config, 'last-participant'));
		expect(dealtAgain.ok).toBe(true);
		if (!dealtAgain.ok) return;
		expectConserved(dealtAgain.state, catalog);
	});

	describe('a PENDING joiner who dies before cleanupRound admits them (Important 4)', () => {
		it('rejects a non-GM actor — the pending-join withdrawal path is GM-only', () => {
			const state = dealtState('pending-death-auth');
			const joined = admitPendingJoinTenure(state, 'tenure-5', 'user-carol', catalog);
			if (!joined.ok) throw joined;
			const result = markTenureDead(joined.state, 'tenure-5', ctxFor(playerActor('tenure-1'), catalog, config, 'pending-death-auth'));
			expect(result).toMatchObject({ ok: false, rejection: { code: 'not-authorized' } });
		});

		it('withdraws the pending join on GM death — never admitted by a later cleanupRound', () => {
			const state = dealtState('pending-death');
			const joined = admitPendingJoinTenure(state, 'tenure-5', 'user-carol', catalog);
			if (!joined.ok) throw joined;
			expect(readChallengeState(joined.state)!.pendingJoinTenureIds).toEqual(['tenure-5']);

			const result = markTenureDead(joined.state, 'tenure-5', ctxFor(GM, catalog, config, 'pending-death'));
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			const challenge = readChallengeState(result.state)!;
			expect(challenge.pendingJoinTenureIds).toEqual([]);
			expect(challenge.participantTenureIds).toEqual(TENURE_IDS);
			expectConserved(result.state, catalog);

			// Advance to a legal cleanup boundary and confirm the dead pending
			// tenure is never admitted into the roster.
			const handA = findZoneDescriptor(result.state, challengeHandZoneId('tenure-1'))!;
			const placedA = placeInitiative(result.state, 'tenure-1', handA.cards[0], ctxFor(playerActor('tenure-1'), catalog, config, 'pending-death'));
			if (!placedA.ok) throw placedA;
			const handB = findZoneDescriptor(placedA.state, challengeHandZoneId('tenure-2'))!;
			const placedB = placeInitiative(placedA.state, 'tenure-2', handB.cards[0], ctxFor(playerActor('tenure-2'), catalog, config, 'pending-death'));
			if (!placedB.ok) throw placedB;
			const revealed = revealInitiative(placedB.state, ctxFor(GM, catalog, config, 'pending-death'));
			if (!revealed.ok) throw revealed;
			const cleaned = cleanupRound(revealed.state, ctxFor(GM, catalog, config, 'pending-death'));
			if (!cleaned.ok) throw cleaned;
			expect(readChallengeState(cleaned.state)!.participantTenureIds).toEqual(TENURE_IDS);
			expect(findZoneDescriptor(cleaned.state, challengeHandZoneId('tenure-5'))).toBeUndefined();
		});
	});
});

describe('admitPendingJoinTenure — boundary-only admission (O3)', () => {
	const catalog = makeRichSessionCatalogFixture();
	const { procedures, formulas } = getTarotProcedures();
	const config = buildChallengeConfig(procedures, formulas);

	it('is a no-op (same state reference) outside an active Challenge round', () => {
		const state = makeSessionFixture('no-challenge-join');
		const result = admitPendingJoinTenure(state, 'tenure-5', 'user-carol', catalog);
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

		const result = admitPendingJoinTenure(begun.state, 'tenure-5', 'user-carol', catalog);
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

		const first = admitPendingJoinTenure(begun.state, 'tenure-5', 'user-carol', catalog);
		if (!first.ok) throw first;
		const second = admitPendingJoinTenure(first.state, 'tenure-5', 'user-carol', catalog);
		expect(second).toEqual({ ok: true, state: first.state, events: [] });

		const alreadyActive = admitPendingJoinTenure(first.state, 'tenure-1', 'user-alice', catalog);
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

		const joined = admitPendingJoinTenure(begun.state, 'tenure-5', 'user-carol', catalog);
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

		// Branch-fix I4: cleanupRound admits the pending join with NO
		// `options.tenureOwners` — the owner was recorded at `admitPendingJoinTenure`
		// (user-carol), so cleanup no longer needs the caller to re-supply it (the
		// UI sends `{ type: 'cleanup-round' }` with none). Previously this test
		// papered over the gap by passing `{ tenureOwners: { 'tenure-5': ... } }`.
		const cleaned = cleanupRound(revealed.state, ctxFor(GM, catalog, config, 'boundary'));
		if (!cleaned.ok) throw cleaned;
		const challengeAfterCleanup = readChallengeState(cleaned.state)!;
		expect(challengeAfterCleanup.participantTenureIds).toEqual([...TENURE_IDS, 'tenure-5']);
		expect(challengeAfterCleanup.pendingJoinTenureIds).toEqual([]);
		expect(challengeAfterCleanup.tenureOwners['tenure-5']).toBe('user-carol');
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
