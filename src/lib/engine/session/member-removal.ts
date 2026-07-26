/**
 * Removing a participant from a live session (Increment 4 Task 6) — the pure
 * card consequences of a player leaving or being removed mid-session.
 *
 * The rules the plan fixes:
 * - Every private card the departing user holds (hand, facedown, prepared,
 *   Challenge zones, inspiration, High Chant staging) returns to its owning
 *   DRAW pile, followed by an authoritative shuffle of each pile that
 *   received cards — nobody learns what they held, and the deck's order
 *   gives nothing away.
 * - Public cards move through their configured cleanup destinations: a
 *   procedure the departing adventurer was driving is closed and its public
 *   cards go to their deck's discard, exactly where completing it would have
 *   sent them.
 * - An active Challenge drops the departing tenure(s) from its roster,
 *   pending joins, budgets, initiative order and tie groups.
 * - The public event is COUNT-ONLY: how many cards went back, never which.
 *
 * Pure — no UI/DB/network imports.
 */

import type { CardId, SessionEngineStateV1, SessionEvent, TarotCardCatalog } from '$lib/types/session';
import { shuffle, type Rng } from '../rng';
import { assertSessionInvariants } from './invariants';
import { readChallengeState, writeChallengeState } from './procedures/challenge/reducer';
import { readGuidedTest } from './procedures/test-of-fate';
import { readGroupTest } from './procedures/group-test';
import { readCampProcedure } from './procedures/camp';
import { readFiniteProcedure } from './procedures/finite-procedure';

export interface RemoveParticipantInput {
	membershipId: string;
	userId: string;
	/** Every tenure the departing membership held (usually one). */
	tenureIds: string[];
	reason: 'left' | 'removed';
}

export interface RemoveParticipantResult {
	state: SessionEngineStateV1;
	events: SessionEvent[];
	returnedCardCount: number;
}

export function removeParticipantFromSession(
	state: SessionEngineStateV1,
	input: RemoveParticipantInput,
	rng: Rng,
	catalog: TarotCardCatalog
): RemoveParticipantResult {
	let working = state;
	let toPlayerDraw: CardId[] = [];
	let toMajorDraw: CardId[] = [];

	// 1. Private zones: everything the user owned returns to its draw pile.
	const departingZones = working.privateZones.filter((zone) => zone.ownerUserId === input.userId);
	for (const zone of departingZones) {
		for (const cardId of zone.cards) {
			if (catalog[cardId]?.deck === 'major') toMajorDraw.push(cardId);
			else toPlayerDraw.push(cardId);
		}
	}
	working = { ...working, privateZones: working.privateZones.filter((zone) => zone.ownerUserId !== input.userId) };

	// 2. A procedure the departing adventurer was driving is closed; its public
	// cards take their configured cleanup destination (the deck discard, as
	// completion would have done). A GM-driven procedure survives untouched.
	const tenureSet = new Set(input.tenureIds);
	working = closeDepartedProcedures(working, tenureSet, catalog);

	// 3. Challenge roster removal — participants, pending joins, budgets,
	// initiative seats, tie groups. Card zones were swept in step 1 (hands) or
	// stay where the public record puts them (a revealed initiative card is
	// public history).
	const challenge = readChallengeState(working);
	if (challenge) {
		const next = {
			...challenge,
			participantTenureIds: challenge.participantTenureIds.filter((id) => !tenureSet.has(id)),
			pendingJoinTenureIds: challenge.pendingJoinTenureIds.filter((id) => !tenureSet.has(id)),
			tenureOwners: Object.fromEntries(Object.entries(challenge.tenureOwners).filter(([id]) => !tenureSet.has(id))),
			budgets: Object.fromEntries(Object.entries(challenge.budgets).filter(([id]) => !tenureSet.has(id))),
			initiativeOrder: challenge.initiativeOrder.filter((entry) => !tenureSet.has(entry.tenureId)),
			tiedGroups: challenge.tiedGroups
				.map((group) => group.filter((id) => !tenureSet.has(id)))
				.filter((group) => group.length > 1),
			activeTurnIndex: adjustActiveTurnIndex(
				challenge.initiativeOrder.map((entry) => entry.tenureId),
				challenge.activeTurnIndex,
				tenureSet
			)
		};
		working = writeChallengeState(working, next);
	}

	// 4. Return and shuffle. The shuffle is what makes the return authoritative:
	// without it, pile position would leak what the departed hand held.
	const returnedCardCount = toPlayerDraw.length + toMajorDraw.length;
	if (toPlayerDraw.length > 0) {
		working = { ...working, playerDraw: shuffle([...working.playerDraw, ...toPlayerDraw], rng) };
	}
	if (toMajorDraw.length > 0) {
		working = { ...working, majorDraw: shuffle([...working.majorDraw, ...toMajorDraw], rng) };
	}

	assertSessionInvariants(working, catalog);

	const events: SessionEvent[] = [
		{
			kind: 'session-participant-removed',
			publicPayload: {
				membershipId: input.membershipId,
				reason: input.reason,
				returnedCardCount,
				tenureCount: input.tenureIds.length
			}
		}
	];
	return { state: working, events, returnedCardCount };
}

/**
 * Re-points the active initiative seat after some seats are removed.
 *
 * Clamping was wrong (review finding): for seats `[A,B,C]` with B active
 * (index 1), removing A left index 1 — which now addresses C, silently handing
 * the turn to the wrong player. And removing the last remaining seat clamped to
 * 0, leaving an index on an empty order that wedges every later turn command.
 *
 * The rule instead: keep the SAME SEAT active by counting how many surviving
 * seats precede it — which is its new index. If the active seat itself departed,
 * the turn passes to whoever now occupies that position (wrapping to the first
 * remaining seat if the departing seat was last). An emptied order has no active
 * turn at all.
 *
 * The count is POSITIONAL, never `indexOf(tenureId)` (second-pass review): a
 * Fool interrupt inserts a second seat for the SAME tenure, so
 * `initiativeOrder` legitimately repeats a tenure id and `indexOf` would snap
 * the turn back to that tenure's already-spent normal seat.
 *
 * Exported for direct testing — the arithmetic is the whole defect.
 */
export function adjustActiveTurnIndex(
	tenureIds: readonly string[],
	activeTurnIndex: number | null,
	removed: ReadonlySet<string>
): number | null {
	if (activeTurnIndex === null) return null;
	const survivingCount = tenureIds.filter((tenureId) => !removed.has(tenureId)).length;
	if (survivingCount === 0) return null;

	// Surviving seats strictly before the active one — the active seat's new
	// index if it survives, or the position the turn falls to if it does not.
	const survivorsBefore = tenureIds.slice(0, activeTurnIndex).filter((tenureId) => !removed.has(tenureId)).length;
	const activeTenureId = tenureIds[activeTurnIndex];
	if (activeTenureId !== undefined && !removed.has(activeTenureId)) return survivorsBefore;
	return survivorsBefore >= survivingCount ? 0 : survivorsBefore;
}

/** Closes any guided test / group test / Camp / finite procedure whose acting
 * tenure departed: public zone cards go to their deck's discard, the zones are
 * removed, and the slot clears. */
function closeDepartedProcedures(
	state: SessionEngineStateV1,
	tenureSet: Set<string>,
	catalog: TarotCardCatalog
): SessionEngineStateV1 {
	let working = state;

	const test = readGuidedTest(working);
	const group = readGroupTest(working);
	const testDeparted = test !== undefined && tenureSet.has(test.actorTenureId);
	const groupDeparted =
		group !== undefined && (tenureSet.has(group.mostQualifiedTenureId) || tenureSet.has(group.leastQualifiedTenureId));
	if (testDeparted || groupDeparted) {
		working = discardPublicZonesByPrefix(working, 'test-of-fate:', catalog);
		const cleared = { ...working };
		delete cleared.guidedTest;
		delete cleared.groupTest;
		working = cleared;
	}

	const camp = readCampProcedure(working);
	if (camp) {
		const acting = camp.kind === 'high-chant' ? camp.performerTenureId : camp.actorTenureId;
		if (tenureSet.has(acting)) {
			working = discardPublicZonesByPrefix(working, 'camp-leeches:', catalog);
			working = { ...working, procedure: null };
		}
	}

	const finite = readFiniteProcedure(working);
	if (finite && finite.actorTenureId !== null && tenureSet.has(finite.actorTenureId)) {
		working = discardPublicZonesByPrefix(working, 'finite:', catalog);
		working = discardPendingZonesByPrefix(working, 'finite-pending:', catalog);
		working = { ...working, procedure: null };
	}

	return working;
}

function discardPublicZonesByPrefix(state: SessionEngineStateV1, prefix: string, catalog: TarotCardCatalog): SessionEngineStateV1 {
	let playerDiscard = state.playerDiscard;
	let majorDiscard = state.majorDiscard;
	for (const zone of state.publicZones) {
		if (!zone.id.startsWith(prefix)) continue;
		for (const cardId of zone.cards) {
			if (catalog[cardId]?.deck === 'major') majorDiscard = [cardId, ...majorDiscard];
			else playerDiscard = [cardId, ...playerDiscard];
		}
	}
	return {
		...state,
		playerDiscard,
		majorDiscard,
		publicZones: state.publicZones.filter((zone) => !zone.id.startsWith(prefix))
	};
}

function discardPendingZonesByPrefix(state: SessionEngineStateV1, prefix: string, catalog: TarotCardCatalog): SessionEngineStateV1 {
	let playerDiscard = state.playerDiscard;
	let majorDiscard = state.majorDiscard;
	for (const zone of state.pendingZones) {
		if (!zone.id.startsWith(prefix)) continue;
		for (const cardId of zone.cards) {
			if (catalog[cardId]?.deck === 'major') majorDiscard = [cardId, ...majorDiscard];
			else playerDiscard = [cardId, ...playerDiscard];
		}
	}
	return {
		...state,
		playerDiscard,
		majorDiscard,
		pendingZones: state.pendingZones.filter((zone) => !zone.id.startsWith(prefix))
	};
}
