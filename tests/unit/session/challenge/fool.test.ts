import { describe, expect, it } from 'vitest';
import { getTarotProcedures } from '$lib/server/content/loader';
import { buildChallengeConfig } from '$lib/engine/session/procedures/challenge/schema';
import type { ChallengeConfig } from '$lib/engine/session/procedures/challenge/types';
import {
	beginChallenge,
	challengeHandZoneId,
	readChallengeState,
	type ChallengeReduceContext
} from '$lib/engine/session/procedures/challenge/reducer';
import { dealRound } from '$lib/engine/session/procedures/challenge/deal';
import { placeInitiative, revealInitiative } from '$lib/engine/session/procedures/challenge/initiative';
import { applyPlayerAction, applyPlayerMinorAction, beginTurns, endTurn } from '$lib/engine/session/procedures/challenge/turns';
import { playFool } from '$lib/engine/session/procedures/challenge/fool';
import { assertSessionInvariants } from '$lib/engine/session/invariants';
import { findZoneDescriptor } from '$lib/engine/session/state';
import { makeRng } from '$lib/engine/rng';
import { makeRichSessionCatalogFixture, makeSessionFixture } from '../../../fixtures/session';
import type { CardId, SessionActor, SessionEngineStateV1, TarotCardCatalog } from '$lib/types/session';

const GM: SessionActor = { kind: 'gm', userId: 'gm-1' };
const TENURE_OWNERS: Record<string, string> = { 'tenure-1': 'user-alice' };

function playerActor(): SessionActor {
	return { kind: 'player', userId: 'user-alice' };
}

function ctxFor(actor: SessionActor, catalog: TarotCardCatalog, config: ChallengeConfig, seed: string): ChallengeReduceContext {
	return { actor, runtime: { catalog }, rng: makeRng(seed), config };
}

function expectConserved(state: SessionEngineStateV1, catalog: TarotCardCatalog): void {
	expect(() => assertSessionInvariants(state, catalog)).not.toThrow();
}

/** Mirrors `turns.test.ts`'s `forceHand` — replaces `tenureId`'s ENTIRE hand
 * with exactly `cardIds`, conserving the fixture's total card count. */
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

describe('The Fool interrupt (O5)', () => {
	const catalog = makeRichSessionCatalogFixture();
	const { procedures, formulas } = getTarotProcedures();
	const config = buildChallengeConfig(procedures, formulas);

	/** A single-participant Challenge ready for `turns`, tenure-1 holding the
	 * Fool plus three known other cards; Initiative was placed with a
	 * DIFFERENT card so the Fool and its intended pairing both remain in hand
	 * for the test itself. */
	function readyWithFoolInHand(seed: string) {
		const state = makeSessionFixture(seed);
		const gmCtx = ctxFor(GM, catalog, config, seed);
		const begun = beginChallenge(state, { participantTenureIds: ['tenure-1'], tenureOwners: TENURE_OWNERS, enemyFacts: [] }, gmCtx);
		if (!begun.ok) throw begun;
		const dealResult = dealRound(begun.state, gmCtx);
		if (!dealResult.ok) throw dealResult;

		const forced = forceHand(dealResult.state, 'tenure-1', ['fool', 'cups-v', 'swords-vii', 'wands-iii']);
		const playerCtx = ctxFor(playerActor(), catalog, config, seed);
		const placed = placeInitiative(forced, 'tenure-1', 'swords-vii', playerCtx);
		if (!placed.ok) throw placed;
		const revealed = revealInitiative(placed.state, gmCtx);
		if (!revealed.ok) throw revealed;
		const begunTurns = beginTurns(revealed.state, gmCtx);
		if (!begunTurns.ok) throw begunTurns;

		return { state: begunTurns.state, gmCtx, playerCtx };
	}

	it('emits fool-interrupt-played, then the paired card`s challenge-card-played, then extra-turn-scheduled, in that exact order', () => {
		const { state, playerCtx } = readyWithFoolInHand('fool-order');

		const result = playFool(state, 'tenure-1', 'cups-v', playerCtx);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.events.map((event) => event.kind)).toEqual(['fool-interrupt-played', 'challenge-card-played', 'extra-turn-scheduled']);
		expectConserved(result.state, catalog);
	});

	it('tags the fool-interrupt-played event with tenureId, matching every sibling Challenge event (coordinator follow-up #6)', () => {
		const { state, playerCtx } = readyWithFoolInHand('fool-tenure-tag');
		const result = playFool(state, 'tenure-1', 'cups-v', playerCtx);
		if (!result.ok) throw result;

		const foolEvent = result.events.find((event) => event.kind === 'fool-interrupt-played');
		expect(foolEvent?.publicPayload).toMatchObject({ tenureId: 'tenure-1' });
	});

	it('moves both the Fool and the paired card to the public played zone, conserving every card', () => {
		const { state, playerCtx } = readyWithFoolInHand('fool-conserve');
		const result = playFool(state, 'tenure-1', 'cups-v', playerCtx);
		if (!result.ok) throw result;

		const played = findZoneDescriptor(result.state, 'challenge-played');
		expect(played?.cards).toEqual(expect.arrayContaining(['fool', 'cups-v']));
		expect(played?.cards).toHaveLength(2);

		const hand = findZoneDescriptor(result.state, challengeHandZoneId('tenure-1'));
		expect(hand?.cards).not.toContain('fool');
		expect(hand?.cards).not.toContain('cups-v');
		expectConserved(result.state, catalog);
	});

	it('does not decrement the paired card`s ordinary one-card-per-turn budget for the Fool itself', () => {
		const { state, playerCtx } = readyWithFoolInHand('fool-budget');
		const result = playFool(state, 'tenure-1', 'cups-v', playerCtx);
		if (!result.ok) throw result;

		// Exactly one card's worth of budget was spent (the paired card) — the
		// Fool itself, an interrupt, never counted against it.
		expect(readChallengeState(result.state)).toMatchObject({
			budgets: { 'tenure-1': { cardsThisTurn: 1, actionTaken: true } }
		});
	});

	it('inserts exactly one extra turn immediately after the current one — never a second one', () => {
		const { state, playerCtx } = readyWithFoolInHand('fool-one-extra');
		const result = playFool(state, 'tenure-1', 'cups-v', playerCtx);
		if (!result.ok) throw result;

		const challenge = readChallengeState(result.state)!;
		expect(challenge.initiativeOrder).toHaveLength(2);
		expect(challenge.initiativeOrder[1]).toMatchObject({ tenureId: 'tenure-1', turnKind: 'fool-extra' });
	});

	it('grants the extra turn no minor actions, but a full action IS allowed', () => {
		const { state, playerCtx } = readyWithFoolInHand('fool-extra-no-minor');
		const foolResult = playFool(state, 'tenure-1', 'cups-v', playerCtx);
		if (!foolResult.ok) throw foolResult;

		const ended = endTurn(foolResult.state, playerCtx);
		if (!ended.ok) throw ended;
		expect(readChallengeState(ended.state)).toMatchObject({ turnKind: 'fool-extra' });

		const minorAttempt = applyPlayerMinorAction(ended.state, 'tenure-1', 'wands-iii', 'wands', playerCtx);
		expect(minorAttempt).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });

		const actionAttempt = applyPlayerAction(ended.state, 'tenure-1', 'wands-iii', playerCtx);
		expect(actionAttempt.ok).toBe(true);
		expectConserved(actionAttempt.ok ? actionAttempt.state : ended.state, catalog);
	});

	it('rejects a lone Fool (the paired card cannot be the Fool itself)', () => {
		const { state, playerCtx } = readyWithFoolInHand('fool-lone');
		const result = playFool(state, 'tenure-1', 'fool', playerCtx);
		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});

	it('rejects playing the Fool when the participant does not actually hold it', () => {
		const state = makeSessionFixture('fool-not-held');
		const gmCtx = ctxFor(GM, catalog, config, 'fool-not-held');
		const begun = beginChallenge(state, { participantTenureIds: ['tenure-1'], tenureOwners: TENURE_OWNERS, enemyFacts: [] }, gmCtx);
		if (!begun.ok) throw begun;
		const dealResult = dealRound(begun.state, gmCtx);
		if (!dealResult.ok) throw dealResult;
		const forced = forceHand(dealResult.state, 'tenure-1', ['cups-v', 'swords-vii', 'wands-iii', 'pentacles-iv']);
		const playerCtx = ctxFor(playerActor(), catalog, config, 'fool-not-held');
		const placed = placeInitiative(forced, 'tenure-1', 'swords-vii', playerCtx);
		if (!placed.ok) throw placed;
		const revealed = revealInitiative(placed.state, gmCtx);
		if (!revealed.ok) throw revealed;
		const begunTurns = beginTurns(revealed.state, gmCtx);
		if (!begunTurns.ok) throw begunTurns;

		const result = playFool(begunTurns.state, 'tenure-1', 'cups-v', playerCtx);
		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});

	it('rejects pairing the Fool with a card the participant does not hold', () => {
		const { state, playerCtx } = readyWithFoolInHand('fool-paired-not-held');
		const result = playFool(state, 'tenure-1', 'swords-king', playerCtx);
		expect(result).toMatchObject({ ok: false, rejection: { code: 'illegal-command' } });
	});

	it('rejects a non-owning player', () => {
		const { state } = readyWithFoolInHand('fool-not-owner');
		const result = playFool(state, 'tenure-1', 'cups-v', ctxFor({ kind: 'player', userId: 'user-mallory' }, catalog, config, 'fool-not-owner'));
		expect(result).toMatchObject({ ok: false, rejection: { code: 'not-authorized' } });
	});

	it('does not schedule an additional reshuffle when played (only the earlier deal-time Fool draw scheduled one)', () => {
		const { state, playerCtx } = readyWithFoolInHand('fool-no-extra-reshuffle');
		const before = state.reshuffleAtBoundary;
		const result = playFool(state, 'tenure-1', 'cups-v', playerCtx);
		if (!result.ok) throw result;
		expect(result.state.reshuffleAtBoundary).toEqual(before);
	});
});
