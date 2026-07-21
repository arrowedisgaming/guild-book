/**
 * The Fool interrupt (Ch7 "The Fool" / Increment 3 Task 3 binding override
 * O5). Pure — no UI/DB/network imports (see
 * `tests/unit/session/import-boundaries.test.ts`).
 *
 * "The Fool is not played like other Challenge cards. The Fool has a value
 * of 0 and is always played in conjunction with another card. When you play
 * the Fool, you get an additional turn ... Additionally, this counts as an
 * interrupt action. The Fool always goes first, no matter what. Essentially,
 * drawing the Fool allows you to take two turns (but no minor actions)
 * during a round" (`challenge-the-fool`).
 *
 * `playFool` therefore, in order:
 *
 * 1. Resolves the Fool card itself FIRST, moving it out of the player's hand
 *    directly (bypassing `turns.ts`'s `spendCard`/budget machinery entirely
 *    — "Interrupt actions do not count towards the one card per turn
 *    limit," so the Fool must never touch `cardsThisTurn`/`actionTaken`).
 * 2. Resolves the paired card "according to normal rules" — reusing
 *    `turns.ts`'s `applyPlayerAction` verbatim (not a parallel
 *    reimplementation), so the paired card DOES spend the turn's one-card
 *    budget exactly like an ordinary action would.
 * 3. Inserts one extra turn immediately after the current one, with
 *    `turnKind: 'fool-extra'` (`types.ts`'s additive `ChallengeInitiativeEntry
 *    .turnKind`) so `turns.ts`'s `endTurn`/`applyPlayerMinorAction` grant it
 *    zero minor actions once reached, without a second, parallel structure
 *    duplicating `initiativeOrder`.
 *
 * It never grants a second extra turn from the paired card (nothing here
 * recurses into `playFool` for the paired card — only a genuine second Fool
 * draw could ever trigger that, and there is exactly one Fool in the deck),
 * and it does not reshuffle immediately: drawing the Fool already scheduled
 * both decks for reshuffle at `dealRound` time (`card-commands.ts`'s
 * `scheduleFoolReshuffleIfDrawn`, fired on the DRAW, not the later PLAY) —
 * playing it here never re-triggers that scheduling, and Task 2's
 * `cleanupRound` resolves it at the round boundary, exactly as `round.test.ts`
 * already proves for the deal-time scheduling this reuses.
 */

import { findZoneDescriptor } from '../../state';
import { reduceSession } from '../../reducer';
import { assertSessionInvariants } from '../../invariants';
import type { CardId, SessionEngineStateV1, SessionEvent } from '$lib/types/session';
import type { ChallengeInitiativeEntry, ChallengeStateV1 } from './types';
import { challengeHandZoneId, readChallengeState, reject, writeChallengeState, type ChallengeReduceContext, type SessionReduceResult } from './reducer';
import { applyPlayerAction, activeTurnEntry, ensurePlayedZone, isRejection, requirePlayerTurn, CHALLENGE_PLAYED_ZONE_ID } from './turns';

/** The Fool's stable content-pack card id — mirrors `card-commands.ts`'s
 * private `FOOL_CARD_ID` constant (spec §8.2); duplicated locally rather than
 * imported since that constant isn't exported (it's an internal detail of
 * the shared move-command handler, not part of its public surface). */
const FOOL_CARD_ID = 'fool';

/**
 * Plays the Fool from `tenureId`'s hand paired with `pairedCardId` (which
 * must be a DIFFERENT card currently in the same hand). Rejects a lone Fool
 * (no valid, distinct paired card), rejects unless it is currently
 * `tenureId`'s own active turn, and rejects a non-owning player (GM has full
 * authority, matching every other Challenge command).
 *
 * Emits exactly three events, in this order (Increment 3 Task 3 binding
 * override O5 — the event-order assertion is binding):
 * `fool-interrupt-played`, then the paired card's ordinary
 * `challenge-card-played` (via `applyPlayerAction`), then
 * `extra-turn-scheduled`.
 */
export function playFool(
	state: SessionEngineStateV1,
	tenureId: string,
	pairedCardId: CardId,
	context: ChallengeReduceContext
): SessionReduceResult {
	const guard = requirePlayerTurn(state, tenureId, context);
	if (isRejection(guard)) return { ok: false, rejection: guard };

	if (pairedCardId === FOOL_CARD_ID) {
		return reject('illegal-command', 'the Fool cannot be paired with itself — a lone Fool is not a legal play');
	}

	const handZoneId = challengeHandZoneId(tenureId);
	const hand = findZoneDescriptor(state, handZoneId);
	if (!hand || !hand.cards.includes(FOOL_CARD_ID)) {
		return reject('illegal-command', `${tenureId} does not hold the Fool`);
	}
	if (!hand.cards.includes(pairedCardId)) {
		return reject('illegal-command', `${tenureId} does not hold the paired card`);
	}

	// 1. The Fool itself — an interrupt, exempt from the one-card budget, so
	// it moves directly rather than through `spendCard`.
	const foolMoveState = ensurePlayedZone(state);
	const foolMove = reduceSession(
		foolMoveState,
		{ type: 'play', sourceZoneId: handZoneId, cardId: FOOL_CARD_ID, destinationZoneId: CHALLENGE_PLAYED_ZONE_ID },
		context
	);
	if (!foolMove.ok) return foolMove;
	const foolEvents: SessionEvent[] = foolMove.events.map((event) => ({ ...event, kind: 'fool-interrupt-played' }));

	// 2. The paired card — resolved exactly like a normal action (this turn's
	// one-card budget genuinely is spent here).
	const pairedResult = applyPlayerAction(foolMove.state, tenureId, pairedCardId, context);
	if (!pairedResult.ok) return pairedResult;

	// 3. Insert one extra turn immediately after the current one.
	const challengeAfterPaired = readChallengeState(pairedResult.state);
	if (!challengeAfterPaired) throw new Error('playFool: Challenge state missing after paired card resolution');
	const currentEntry = activeTurnEntry(challengeAfterPaired);
	if (!currentEntry) throw new Error('playFool: no active turn entry after paired card resolution');
	const insertAt = (challengeAfterPaired.activeTurnIndex ?? 0) + 1;

	const extraEntry: ChallengeInitiativeEntry = { ...currentEntry, turnKind: 'fool-extra' };
	const nextInitiativeOrder = [
		...challengeAfterPaired.initiativeOrder.slice(0, insertAt),
		extraEntry,
		...challengeAfterPaired.initiativeOrder.slice(insertAt)
	];
	const nextChallenge: ChallengeStateV1 = { ...challengeAfterPaired, initiativeOrder: nextInitiativeOrder };
	const nextState = writeChallengeState(pairedResult.state, nextChallenge);
	assertSessionInvariants(nextState, context.runtime.catalog);

	const extraTurnEvent: SessionEvent = {
		kind: 'extra-turn-scheduled',
		publicPayload: { tenureId, insertedAtIndex: insertAt }
	};

	return { ok: true, state: nextState, events: [...foolEvents, ...pairedResult.events, extraTurnEvent] };
}
