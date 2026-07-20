/**
 * Initiative placement and reveal (Ch7 step 2, "Play Initiative" /
 * `challenge-play-initiative` / `challenge-take-turns`). Pure — no
 * UI/DB/network imports (see
 * `tests/unit/session/import-boundaries.test.ts`).
 *
 * Placement stages a player's chosen card facedown in a private zone (the
 * shared engine's generic `player-facedown` zone kind, so the existing
 * projection layer already surfaces a public "occupied card back" for it
 * with zero changes — see `projection.ts`'s `buildPrivateZoneCardBacks`).
 * Reveal transfers every placed card into the one shared public Initiative
 * zone — a `transfer` into a public zone is itself the disclosure event
 * (`card-commands.ts`'s `buildMoveEvent` discloses whenever the destination
 * is public), so no separate `reveal` command is needed — then reorders that
 * zone to the round's actual turn sequence: ascending by card value ("the GM
 * counts up from lowest card (I) through the highest card (king)",
 * `challenge-take-turns`), tied entries broken by roster order
 * (`participantTenureIds` order) exactly as `types.ts` mandates.
 */

import { findZoneDescriptor } from '../../state';
import { reduceSession } from '../../reducer';
import type { CardId, SessionEngineStateV1, SessionEvent } from '$lib/types/session';
import type { ChallengeInitiativeEntry, ChallengeStateV1 } from './types';
import {
	CHALLENGE_INITIATIVE_ZONE_ID,
	challengeHandZoneId,
	challengeInitiativeFacedownZoneId,
	readChallengeState,
	reject,
	writeChallengeState,
	type ChallengeReduceContext,
	type SessionReduceResult
} from './reducer';
import { assertSessionInvariants } from '../../invariants';

/**
 * A participant places `cardId` (which must currently be in their own dealt
 * hand) facedown as their Initiative for the round. Player-only for their
 * own tenure (the GM never places a player's Initiative for them); rejects a
 * repeat placement for the same tenure this round.
 */
export function placeInitiative(
	state: SessionEngineStateV1,
	tenureId: string,
	cardId: CardId,
	context: ChallengeReduceContext
): SessionReduceResult {
	const challenge = readChallengeState(state);
	if (!challenge) return reject('illegal-command', 'no active Challenge round');
	if (challenge.stage !== 'initiative-placement') {
		return reject('illegal-command', `cannot place Initiative during stage ${challenge.stage}`);
	}
	if (!challenge.participantTenureIds.includes(tenureId)) {
		return reject('illegal-command', `${tenureId} is not an active Challenge participant`);
	}
	if (context.actor.kind === 'player' && context.actor.userId !== tenureId) {
		return reject('not-authorized', 'a player may only place their own Initiative');
	}
	if (challenge.initiativeOrder.some((entry) => entry.tenureId === tenureId)) {
		return reject('illegal-command', `${tenureId} has already placed Initiative this round`);
	}

	const transferResult = reduceSession(
		state,
		{
			type: 'transfer',
			sourceZoneId: challengeHandZoneId(tenureId),
			cardId,
			destinationZoneId: challengeInitiativeFacedownZoneId(tenureId)
		},
		context
	);
	if (!transferResult.ok) return transferResult;

	const nextChallenge: ChallengeStateV1 = {
		...challenge,
		initiativeOrder: [
			...challenge.initiativeOrder,
			{ tenureId, cardZoneId: challengeInitiativeFacedownZoneId(tenureId), revealed: false }
		]
	};
	const nextState = writeChallengeState(transferResult.state, nextChallenge);
	assertSessionInvariants(nextState, context.runtime.catalog);
	return { ok: true, state: nextState, events: transferResult.events };
}

/**
 * GM-only batch reveal: every active participant must have placed first.
 * Transfers each placed card into the shared public Initiative zone (which
 * discloses it), reorders that zone to the round's real turn sequence, and
 * rewrites `initiativeOrder` to the revealed, sorted order. Advances
 * `stage` to `'initiative-reveal'` — starting `'turns'` itself (turn index,
 * turn kind) is Task 3's job, out of this task's scope (O5).
 */
export function revealInitiative(state: SessionEngineStateV1, context: ChallengeReduceContext): SessionReduceResult {
	if (context.actor.kind !== 'gm') {
		return reject('not-authorized', 'only the GM may reveal Initiative');
	}
	const challenge = readChallengeState(state);
	if (!challenge) return reject('illegal-command', 'no active Challenge round');
	if (challenge.stage !== 'initiative-placement') {
		return reject('illegal-command', `cannot reveal Initiative during stage ${challenge.stage}`);
	}

	const missing = challenge.participantTenureIds.filter(
		(tenureId) => !challenge.initiativeOrder.some((entry) => entry.tenureId === tenureId)
	);
	if (missing.length > 0) {
		return reject('illegal-command', `Initiative not yet placed for: ${missing.join(', ')}`);
	}

	let nextState = state;
	const events: SessionEvent[] = [];
	const placedCardIds: Record<string, CardId> = {};

	for (const entry of challenge.initiativeOrder) {
		const zone = findZoneDescriptor(nextState, entry.cardZoneId);
		const cardId = zone?.cards[0];
		if (!zone || cardId === undefined) {
			return reject('illegal-command', `Initiative card missing for ${entry.tenureId}`);
		}
		placedCardIds[entry.tenureId] = cardId;

		const transferResult = reduceSession(
			nextState,
			{ type: 'transfer', sourceZoneId: entry.cardZoneId, cardId, destinationZoneId: CHALLENGE_INITIATIVE_ZONE_ID },
			context
		);
		if (!transferResult.ok) return transferResult;
		nextState = transferResult.state;
		events.push(...transferResult.events);
	}

	const rosterIndex = new Map(challenge.participantTenureIds.map((tenureId, index) => [tenureId, index]));
	const sortedEntries = [...challenge.initiativeOrder].sort((a, b) => {
		const valueA = context.runtime.catalog[placedCardIds[a.tenureId]]?.value ?? 0;
		const valueB = context.runtime.catalog[placedCardIds[b.tenureId]]?.value ?? 0;
		if (valueA !== valueB) return valueA - valueB;
		return (rosterIndex.get(a.tenureId) ?? 0) - (rosterIndex.get(b.tenureId) ?? 0);
	});

	const reorderResult = reduceSession(
		nextState,
		{
			type: 'reorder-top',
			zoneId: CHALLENGE_INITIATIVE_ZONE_ID,
			cardIds: sortedEntries.map((entry) => placedCardIds[entry.tenureId])
		},
		context
	);
	if (!reorderResult.ok) return reorderResult;
	nextState = reorderResult.state;
	events.push(...reorderResult.events);

	const revealedOrder: ChallengeInitiativeEntry[] = sortedEntries.map((entry) => ({
		tenureId: entry.tenureId,
		cardZoneId: CHALLENGE_INITIATIVE_ZONE_ID,
		revealed: true
	}));
	const nextChallenge: ChallengeStateV1 = { ...challenge, stage: 'initiative-reveal', initiativeOrder: revealedOrder };
	nextState = writeChallengeState(nextState, nextChallenge);
	assertSessionInvariants(nextState, context.runtime.catalog);

	events.push({
		kind: 'challenge-initiative-revealed',
		publicPayload: { order: revealedOrder.map((entry) => ({ tenureId: entry.tenureId, cardId: placedCardIds[entry.tenureId] })) }
	});

	return { ok: true, state: nextState, events };
}
