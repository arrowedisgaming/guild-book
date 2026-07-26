/**
 * Audited compensating corrections (Increment 4 Task 5 Step 2).
 *
 * Corrections never edit or delete old commands or events. A typed correction
 * applies a LEGAL compensating card transition through the ordinary reducer —
 * same authorization, same invariant checker — and appends a
 * `correction-applied` event linking the original event and carrying the GM's
 * reason. The journal stays append-only; the repair is itself history.
 *
 * `move-card` is the one correction kind v1 needs: every mis-play at a card
 * table is repaired by putting a card where it should have gone.
 *
 * ## Why the SOURCE zone is restricted here
 *
 * The GM has full zone authority on the generic surface (`card-commands.ts`:
 * "The GM has full authority — any zone, any visibility"), so a GM could always
 * move a card out of a hidden zone with a plain `transfer`. Corrections do NOT
 * inherit that reach: a correction names a card the GM must already be able to
 * SEE, because a correction whose source is a player's hand or a draw pile is
 * not repairing a visible mistake — it is either guessing at a hidden card or
 * publishing one. Restricting the source to non-hidden, non-player-private
 * zones is what makes `CorrectionDialog`'s promise ("the GM cannot name a card
 * they cannot see") true in the SERVER, not just in the UI's option list.
 * Death correction is deliberately NOT here: reversing a death continues
 * through the character life service (`markCharacterDead`'s compensating
 * path), and never restores a tenure — a new tenure is attached instead,
 * exactly as a replacement adventurer would be.
 *
 * Pure — no UI/DB/network imports.
 */

import type { SessionEngineStateV1, SessionEvent, SessionRejection } from '$lib/types/session';
import { reduceSession, type ReduceContext } from './reducer';
import type { ReduceResult } from './result';
import { findZoneDescriptor } from './state';

export type SessionReduceResult = ReduceResult<SessionEngineStateV1, SessionEvent, SessionRejection>;

export interface MoveCardCorrection {
	kind: 'move-card';
	/** The event being compensated for — linked, never edited. */
	targetEventId: string;
	/** The GM's stated reason, required and audited. */
	reason: string;
	sourceZoneId: string;
	cardId: string;
	destinationZoneId: string;
}

export type CorrectionCommand = MoveCardCorrection;

export function applyCorrection(
	state: SessionEngineStateV1,
	command: CorrectionCommand,
	context: ReduceContext
): SessionReduceResult {
	if (context.actor.kind !== 'gm') {
		return { ok: false, rejection: { code: 'not-authorized', message: 'only the GM may apply a correction' } };
	}
	if (command.reason.trim().length === 0) {
		return { ok: false, rejection: { code: 'illegal-command', message: 'a correction requires a stated reason' } };
	}

	// The source must be a zone whose contents are already visible to the table
	// (a public area or a discard pile). A hidden zone (draw piles, pending
	// procedure zones) or a player's private zone is refused — see the file
	// header on why corrections do not inherit the GM's generic full reach.
	const source = findZoneDescriptor(state, command.sourceZoneId);
	if (!source) {
		return { ok: false, rejection: { code: 'illegal-command', message: `source zone not found: ${command.sourceZoneId}` } };
	}
	if (source.visibility !== 'public' && source.visibility !== 'public-top') {
		return {
			ok: false,
			rejection: {
				code: 'illegal-command',
				message: 'a correction may only move a card the table can already see — not one from a hand, a draw pile, or a pending zone'
			}
		};
	}

	// The compensating transition is an ORDINARY transfer: full legality
	// checks, card-conservation invariant, and its own event with the same
	// visibility discipline as any other move. A repair the reducer would
	// reject is not a repair the engine will force.
	const moved = reduceSession(
		state,
		{ type: 'transfer', sourceZoneId: command.sourceZoneId, cardId: command.cardId, destinationZoneId: command.destinationZoneId },
		context
	);
	if (!moved.ok) return moved;

	const applied: SessionEvent = {
		kind: 'correction-applied',
		publicPayload: {
			targetEventId: command.targetEventId,
			correctionKind: command.kind,
			reason: command.reason,
			sourceZoneId: command.sourceZoneId,
			destinationZoneId: command.destinationZoneId
		}
	};
	return { ok: true, state: moved.state, events: [...moved.events, applied] };
}
