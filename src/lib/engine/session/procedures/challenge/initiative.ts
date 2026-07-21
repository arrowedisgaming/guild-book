/**
 * Initiative placement and reveal (Ch7 step 2, "Play Initiative" /
 * `challenge-play-initiative` / `challenge-take-turns`). Pure — no
 * UI/DB/network imports (see
 * `tests/unit/session/import-boundaries.test.ts`).
 *
 * Two rosters place Initiative: players, one card each from their own hand
 * (minor deck), and the GM, one card from `gmHand` (major deck) for each
 * `enemyFacts` ENTRY (not per `count`) — `challenge-play-initiative`: "The GM
 * will play one Initiative card for each significant character or group of
 * characters they control." `enemyFacts` already *is* that roster of
 * significant characters/groups; `count` (`types.ts`) is how many enemies an
 * entry represents for the *hand-size formula*'s headcount
 * (`deal.ts`'s `calculateGmHandSize`), not for how many Initiative cards it
 * needs — a group of twelve imps entered as one entry with `count: 12` still
 * places exactly one card here, which is the entire point of the "or group"
 * clause.
 *
 * Both kinds of placement stage a card facedown in a zone the public
 * projection already surfaces an occupied-but-hidden placeholder for with
 * zero projection-layer changes: a player's card goes to a
 * `player-facedown` private zone (`projection.ts`'s
 * `buildPrivateZoneCardBacks`); the GM's card, which cannot live in
 * `state.privateZones` (every entry there is unconditionally owned by a
 * player — see `reducer.ts`'s `challengeGmInitiativeZoneId`), goes to a
 * `pendingZones` entry instead (`projection.ts`'s `buildPublicProjection`'s
 * `pendingZoneCounts`). Reveal transfers every placed card (both rosters)
 * into the one shared public Initiative zone — a `transfer` into a public
 * zone is itself the disclosure event (`card-commands.ts`'s
 * `buildMoveEvent` discloses whenever the destination is public), so no
 * separate `reveal` command is needed — then reorders that zone to a stable
 * default turn sequence: ascending by card value ("the GM counts up from
 * lowest card (I) through the highest card (king)", `challenge-take-turns`).
 *
 * Ties are NOT auto-resolved. `challenge-play-initiative`'s "Tied
 * Initiative" section makes a tie a table decision, not an engine ruling:
 * "Players with the same Initiative decide among themselves who will
 * declare their actions first. If there is a tie between a GM character and
 * an adventurer, the GM determines who declares first." `initiativeOrder`
 * still needs *some* concrete sequence (Task 3's turn loop has to iterate
 * something, and tests need a deterministic order to assert against), so
 * ties break by combined roster order (`participantTenureIds` then
 * `enemyFacts` order) as a practical default — but that default is never
 * presented as a ruling: `revealInitiative`'s public event additionally
 * carries `tiedGroups`, the id groups that share a value, so the table can
 * see a tie exists and adjudicate it themselves.
 */

import { findZoneDescriptor } from '../../state';
import { reduceSession } from '../../reducer';
import type { CardId, SessionEngineStateV1, SessionEvent } from '$lib/types/session';
import type { ChallengeInitiativeEntry, ChallengeStateV1 } from './types';
import {
	CHALLENGE_INITIATIVE_ZONE_ID,
	challengeGmInitiativeZoneId,
	challengeHandZoneId,
	challengeInitiativeFacedownZoneId,
	readChallengeState,
	reject,
	writeChallengeState,
	type ChallengeReduceContext,
	type SessionReduceResult
} from './reducer';
import { assertSessionInvariants } from '../../invariants';
import { FIXED_ZONE_IDS } from '../../zones';

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
 * The GM places `cardId` (which must currently be in `gmHand`, hence major
 * deck) facedown as the Initiative for `enemyFactId` — one of the current
 * round's `enemyFacts` entries, i.e. one "significant character or group of
 * characters" the GM controls (`challenge-play-initiative`). GM-only;
 * rejects an unknown `enemyFactId` or a repeat placement for the same one
 * this round. Uses `initiativeOrder`'s `tenureId` field to key the entry by
 * `enemyFactId` — the field is a plain participant-or-enemy roster key, not
 * restricted to player tenures (see `types.ts`'s doc comment).
 */
export function placeGmInitiative(
	state: SessionEngineStateV1,
	enemyFactId: string,
	cardId: CardId,
	context: ChallengeReduceContext
): SessionReduceResult {
	if (context.actor.kind !== 'gm') {
		return reject('not-authorized', 'only the GM may place an enemy Initiative');
	}
	const challenge = readChallengeState(state);
	if (!challenge) return reject('illegal-command', 'no active Challenge round');
	if (challenge.stage !== 'initiative-placement') {
		return reject('illegal-command', `cannot place Initiative during stage ${challenge.stage}`);
	}
	if (!challenge.enemyFacts.some((enemy) => enemy.id === enemyFactId)) {
		return reject('illegal-command', `${enemyFactId} is not a current Challenge enemy fact`);
	}
	if (challenge.initiativeOrder.some((entry) => entry.tenureId === enemyFactId)) {
		return reject('illegal-command', `${enemyFactId} has already placed Initiative this round`);
	}

	const transferResult = reduceSession(
		state,
		{
			type: 'transfer',
			sourceZoneId: FIXED_ZONE_IDS.gmHand,
			cardId,
			destinationZoneId: challengeGmInitiativeZoneId(enemyFactId)
		},
		context
	);
	if (!transferResult.ok) return transferResult;

	const nextChallenge: ChallengeStateV1 = {
		...challenge,
		initiativeOrder: [
			...challenge.initiativeOrder,
			{ tenureId: enemyFactId, cardZoneId: challengeGmInitiativeZoneId(enemyFactId), revealed: false }
		]
	};
	const nextState = writeChallengeState(transferResult.state, nextChallenge);
	assertSessionInvariants(nextState, context.runtime.catalog);
	return { ok: true, state: nextState, events: transferResult.events };
}

/** The combined roster order ties break by: players first (their configured
 * order), then enemy groups (their configured order) — a practical,
 * deterministic default only; see the file header re: ties never being an
 * engine ruling. */
function combinedRosterOrder(challenge: ChallengeStateV1): string[] {
	return [...challenge.participantTenureIds, ...challenge.enemyFacts.map((enemy) => enemy.id)];
}

/**
 * GM-only batch reveal: every active participant AND every current enemy
 * fact must have placed first. Transfers each placed card into the shared
 * public Initiative zone (which discloses it), reorders that zone to a
 * stable default turn sequence, and rewrites `initiativeOrder` to the
 * revealed, sorted order. Advances `stage` to `'initiative-reveal'` —
 * starting `'turns'` itself (turn index, turn kind, and what an enemy does
 * when its Initiative comes up — `challenge-enemy-actions`) is Task 3's job,
 * out of this task's scope (O5).
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

	const requiredKeys = combinedRosterOrder(challenge);
	const missing = requiredKeys.filter((key) => !challenge.initiativeOrder.some((entry) => entry.tenureId === key));
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

	const rosterIndex = new Map(requiredKeys.map((key, index) => [key, index]));
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

	// Groups of two-or-more ids that share a card value — a real Ch7 tie the
	// table must adjudicate (see the file header), surfaced here rather than
	// silently resolved by the stable sort above. Computed before the state
	// write below so `tiedGroups` lands in `ChallengeStateV1` itself, not only
	// on this function's event payload (M1 — a later *reader of state*, like
	// Task 3's turn loop or Task 6's UI, must see a tie without replaying the
	// event log).
	const byValue = new Map<number, string[]>();
	for (const entry of sortedEntries) {
		const value = context.runtime.catalog[placedCardIds[entry.tenureId]]?.value ?? 0;
		const group = byValue.get(value) ?? [];
		group.push(entry.tenureId);
		byValue.set(value, group);
	}
	const tiedGroups = [...byValue.values()].filter((group) => group.length > 1);

	const nextChallenge: ChallengeStateV1 = {
		...challenge,
		stage: 'initiative-reveal',
		initiativeOrder: revealedOrder,
		tiedGroups
	};
	nextState = writeChallengeState(nextState, nextChallenge);
	assertSessionInvariants(nextState, context.runtime.catalog);

	events.push({
		kind: 'challenge-initiative-revealed',
		publicPayload: {
			order: revealedOrder.map((entry) => ({ tenureId: entry.tenureId, cardId: placedCardIds[entry.tenureId] })),
			tiedGroups
		}
	});

	return { ok: true, state: nextState, events };
}
