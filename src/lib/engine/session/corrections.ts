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
 * table is repaired by putting a card where it should have gone, and the GM's
 * full zone authority means the compensating `transfer` can reach any zone.
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
