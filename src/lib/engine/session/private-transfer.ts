/**
 * Cross-owner private card moves, shared by every procedure that needs one
 * (Increment 4 Task 3). Pure — no UI/DB/network imports (see
 * `tests/unit/session/import-boundaries.test.ts`).
 *
 * ## Why this can't just call `reduceSession({type: 'transfer', ...})`
 *
 * The shared engine's uniform zone-access rule (`card-commands.ts`'s file
 * header) is deliberately conservative: "a player-initiated `transfer` into a
 * different player's private zone is rejected — only the GM can do that, since
 * Task 2's generic engine has no procedure-specific authority chain
 * (Counsel/High Chant grants) yet; later increments' procedure modules can layer
 * additional permission on top."
 *
 * Challenge's Counsel and Guardian Angel were the first such layer; Camp's High
 * Chant ("Distribute the cards to other players") is the second. That is why
 * these two helpers now live here rather than in
 * `procedures/challenge/transfers.ts`, which is where Increment 3 first wrote
 * them: a Camp procedure importing the Challenge module to hand over a card
 * would couple two unrelated procedures through nothing but a shared primitive.
 * `challenge/transfers.ts` re-exports both, so every existing import site is
 * unchanged.
 *
 * These functions mutate `state.privateZones` directly — bypassing
 * `reduceSession` for this one move only — but ONLY after the calling procedure
 * has independently verified the move is legitimate under its own rules
 * (ownership, stage, per-player caps). They perform no authorization of their
 * own beyond confirming the named zones and card actually exist. Never call them
 * for a move the caller has not already authorized.
 *
 * ## Privacy
 *
 * The public event carries sender tenure, recipient tenure, count, and reason
 * ONLY — never the card's identity. Sender and recipient each get the minimum
 * private payload needed to update their own projection. The GM receives
 * neither: this helper only ever moves cards between `state.privateZones`
 * entries, and every entry there is owned by a PLAYER (`zones.ts`'s
 * `listZoneDescriptors` unconditionally tags them `{kind: 'player', ...}`), so a
 * GM userId can never be `senderUserId`/`recipientUserId` here.
 */

import type { CardId, SessionEngineStateV1, SessionEvent, SessionRejection, TarotCardCatalog } from '$lib/types/session';
import type { ReduceResult } from './result';

export type SessionReduceResult = ReduceResult<SessionEngineStateV1, SessionEvent, SessionRejection>;

function reject(code: SessionRejection['code'], message: string): SessionReduceResult {
	return { ok: false, rejection: { code, message } };
}

/**
 * Moves one card between two `state.privateZones` entries. Validates that both
 * zones exist, that they differ, and that the card is present in the source —
 * rejecting rather than mutating on any failure. Emits no events; the caller
 * owns the disclosure decision.
 */
export function movePrivateCard(
	state: SessionEngineStateV1,
	sourceZoneId: string,
	destinationZoneId: string,
	cardId: CardId
): SessionReduceResult {
	if (sourceZoneId === destinationZoneId) {
		return reject('illegal-command', 'movePrivateCard: source and destination must be different zones');
	}
	const source = state.privateZones.find((zone) => zone.id === sourceZoneId);
	if (!source) return reject('illegal-command', `movePrivateCard: source zone not found: ${sourceZoneId}`);
	if (!source.cards.includes(cardId)) {
		return reject('illegal-command', `movePrivateCard: named card is not present in source zone ${sourceZoneId}`);
	}
	const destination = state.privateZones.find((zone) => zone.id === destinationZoneId);
	if (!destination) return reject('illegal-command', `movePrivateCard: destination zone not found: ${destinationZoneId}`);

	const privateZones = state.privateZones.map((zone) => {
		if (zone.id === sourceZoneId) return { ...zone, cards: zone.cards.filter((id) => id !== cardId) };
		if (zone.id === destinationZoneId) return { ...zone, cards: zone.cards.concat(cardId) };
		return zone;
	});
	return { ok: true, state: { ...state, privateZones }, events: [] };
}

export interface PrivateTransferOptions {
	senderUserId: string;
	recipientUserId: string;
	senderZoneId: string;
	recipientZoneId: string;
	cardId: CardId;
	eventKind: string;
	reason: string;
	/** Merged onto the public payload alongside `count`/`reason` — tenure ids,
	 * never card identity (callers must not put a card id here). */
	publicExtra: Record<string, unknown>;
}

/**
 * Validates the card is a real catalog entry, performs the cross-owner move via
 * `movePrivateCard`, and builds the privacy-correct event (see the file header).
 * Does NOT touch any procedure's own state — per-round caps, modifier instances,
 * and per-player limits are caller-specific bookkeeping.
 *
 * Takes a bare `{ catalog }` rather than a full procedure context so any
 * procedure can call it without adopting another's context shape.
 */
export function performPrivateTransfer(
	state: SessionEngineStateV1,
	options: PrivateTransferOptions,
	runtime: { catalog: TarotCardCatalog }
): SessionReduceResult {
	if (!runtime.catalog[options.cardId]) {
		return reject('content-mismatch', 'unrecognized card referenced for a private transfer');
	}

	const moveResult = movePrivateCard(state, options.senderZoneId, options.recipientZoneId, options.cardId);
	if (!moveResult.ok) return moveResult;

	const event: SessionEvent = {
		kind: options.eventKind,
		publicPayload: { ...options.publicExtra, count: 1, reason: options.reason },
		privatePayloads: {
			[options.senderUserId]: { cardId: options.cardId, direction: 'sent' },
			[options.recipientUserId]: { cardId: options.cardId, direction: 'received' }
		}
	};
	return { ok: true, state: moveResult.state, events: [event] };
}
