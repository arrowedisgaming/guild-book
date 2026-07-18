/**
 * Per-command legality checks and state transitions for the shared tarot
 * table. `reducer.ts` dispatches each `SessionCommand` variant to one handler
 * here; handlers are the only place that mutate (by cloning) session state.
 * Pure — no UI/DB/network imports (see
 * `tests/unit/session/import-boundaries.test.ts`).
 *
 * ## Authorization model
 *
 * One uniform rule governs every zone a command instance names (source,
 * destination, or the single `zoneId` of `reveal`/`reorder-top`/`mulligan`):
 *
 * - The GM has full authority — any zone, any visibility.
 * - A player may act on a zone whose `visibility` is `'private'` only if they
 *   own it; a `'hidden'` zone (draw piles, procedure-owned pending zones)
 *   is GM-only; a `'public'`/`'public-top'` zone is open to any actor (the
 *   analog game's discard piles are physically inspectable — only the
 *   passive projection surfaces just the top by default, spec §8.2).
 *
 * This single rule is what rejects "moving another player's private card"
 * as `not-authorized`, and is deliberately conservative elsewhere (e.g. a
 * player-initiated `transfer` into a different player's private zone is
 * rejected — only the GM can do that) since Task 2's generic engine has no
 * procedure-specific authority chain (Counsel/High Chant grants) yet; later
 * increments' procedure modules can layer additional permission on top.
 *
 * Structural commands (`deal`, `begin-procedure`, `advance-procedure`,
 * `complete-procedure`, `end-round`, `apply-correction`) are GM-only,
 * matching spec §8.6 ("The GM advances phases and rounds") and the
 * `ApplyCorrectionCommand` doc comment ("GM-only compensating command").
 * `reduceSession`'s `legalCommandsForActor` gate is the single source of
 * truth for that restriction (checked before a command ever reaches a
 * handler here) — these handlers do not re-check actor kind themselves, so
 * there is exactly one place that decision lives.
 */

import type {
	AdvanceProcedureCommand,
	ApplyCorrectionCommand,
	BeginProcedureCommand,
	CardId,
	CompleteProcedureCommand,
	DealCommand,
	DiscardCommand,
	DrawCommand,
	EndRoundCommand,
	MulliganCommand,
	PlaceFacedownCommand,
	PlayCommand,
	ReorderTopCommand,
	RevealCommand,
	SelectFromDiscardCommand,
	SessionActor,
	SessionEngineStateV1,
	SessionEvent,
	SessionRejection,
	TarotCardCatalog,
	TransferCommand,
	UserId
} from '$lib/types/session';
import type { Rng } from '../rng';
import { findZoneDescriptor } from './state';
import { drawWithReshuffle, reshuffleDeck } from './shuffle';
import { type ZoneDescriptor, type ZoneOwner } from './zones';
import type { ReduceResult } from './result';

export type SessionReduceResult = ReduceResult<SessionEngineStateV1, SessionEvent, SessionRejection>;

export interface CommandHandlerContext {
	actor: SessionActor;
	catalog: TarotCardCatalog;
	rng: Rng;
}

/** The Fool's stable content-pack card id (spec §8.2). */
const FOOL_CARD_ID = 'fool';

const FIXED_ZONE_FIELDS = ['majorDraw', 'majorDiscard', 'playerDraw', 'playerDiscard', 'gmHand'] as const;
type FixedZoneField = (typeof FIXED_ZONE_FIELDS)[number];

function isFixedZoneField(zoneId: string): zoneId is FixedZoneField {
	return (FIXED_ZONE_FIELDS as readonly string[]).includes(zoneId);
}

function reject(code: SessionRejection['code'], message: string): SessionReduceResult {
	return { ok: false, rejection: { code, message } };
}

// ---------------------------------------------------------------------------
// Zone helpers — the only place that clones a touched array/object.
// ---------------------------------------------------------------------------

/** Replaces one zone's `cards` with `cards`, cloning only that zone's
 * container array (and, for addressable zones, the touched entry) — every
 * other array on `state` keeps its existing reference. */
function setZoneCards(state: SessionEngineStateV1, zoneId: string, cards: CardId[]): SessionEngineStateV1 {
	if (isFixedZoneField(zoneId)) {
		return { ...state, [zoneId]: cards };
	}

	const privateIndex = state.privateZones.findIndex((zone) => zone.id === zoneId);
	if (privateIndex !== -1) {
		const privateZones = state.privateZones.slice();
		privateZones[privateIndex] = { ...privateZones[privateIndex], cards };
		return { ...state, privateZones };
	}

	const publicIndex = state.publicZones.findIndex((zone) => zone.id === zoneId);
	if (publicIndex !== -1) {
		const publicZones = state.publicZones.slice();
		publicZones[publicIndex] = { ...publicZones[publicIndex], cards };
		return { ...state, publicZones };
	}

	const pendingIndex = state.pendingZones.findIndex((zone) => zone.id === zoneId);
	if (pendingIndex !== -1) {
		const pendingZones = state.pendingZones.slice();
		pendingZones[pendingIndex] = { ...pendingZones[pendingIndex], cards };
		return { ...state, pendingZones };
	}

	// Callers always resolve the zone with `findZoneDescriptor` first, so this
	// only fires on an internal bug, never on user input.
	throw new Error(`setZoneCards: unknown zone id "${zoneId}"`);
}

function actorOwnsZoneOwner(actor: SessionActor, owner: ZoneOwner): boolean {
	if (owner.kind === 'player') return actor.kind === 'player' && actor.userId === owner.userId;
	if (owner.kind === 'gm') return actor.kind === 'gm';
	return false;
}

/** The uniform zone-access rule described in the file header. */
export function actorMayAccessZone(actor: SessionActor, zone: ZoneDescriptor): boolean {
	if (actor.kind === 'gm') return true;
	if (zone.visibility === 'private') return actorOwnsZoneOwner(actor, zone.owner);
	if (zone.visibility === 'hidden') return false;
	return true; // 'public' | 'public-top'
}

/** Who privately learns a card's identity when it lands in `zone` (the
 * player who owns a private zone, or the acting GM for `gmHand`/hidden
 * zones). `undefined` means the identity is public — the zone's visibility
 * already discloses it, so no `privatePayloads` entry is needed. */
function privateRecipientForZone(zone: ZoneDescriptor, actor: SessionActor): UserId | undefined {
	if (zone.visibility === 'public' || zone.visibility === 'public-top') return undefined;
	if (zone.owner.kind === 'player') return zone.owner.userId;
	return actor.userId; // gm-owned, or an owner-less hidden zone the GM alone can reach
}

/** Builds a move/draw event whose `publicPayload` can never carry a hidden
 * card id: when the destination has a private recipient, identities are only
 * ever placed in `privatePayloads`. */
function buildMoveEvent(
	kind: string,
	destination: ZoneDescriptor,
	actor: SessionActor,
	cardIds: CardId[],
	publicExtra: Record<string, unknown>
): SessionEvent {
	const recipient = privateRecipientForZone(destination, actor);
	const basePublic = { ...publicExtra, count: cardIds.length };
	if (recipient === undefined) {
		return { kind, publicPayload: { ...basePublic, cardIds } };
	}
	return {
		kind,
		publicPayload: basePublic,
		privatePayloads: { [recipient]: { ...publicExtra, cardIds } }
	};
}

/** Drawing the Fool schedules BOTH decks for reshuffle at the next boundary
 * (`end-round`) — never immediately (spec §8.4). */
function scheduleFoolReshuffleIfDrawn(state: SessionEngineStateV1, drawnCardIds: readonly CardId[]): SessionEngineStateV1 {
	if (!drawnCardIds.includes(FOOL_CARD_ID)) return state;
	return { ...state, reshuffleAtBoundary: { major: true, player: true } };
}

// ---------------------------------------------------------------------------
// draw / deal
// ---------------------------------------------------------------------------

export function handleDraw(command: DrawCommand, state: SessionEngineStateV1, ctx: CommandHandlerContext): SessionReduceResult {
	const destination = findZoneDescriptor(state, command.destinationZoneId);
	if (!destination) return reject('illegal-command', `destination zone not found: ${command.destinationZoneId}`);
	if (!actorMayAccessZone(ctx.actor, destination)) {
		return reject('not-authorized', `actor may not draw into zone ${destination.id}`);
	}
	if (destination.deck !== 'both' && destination.deck !== command.deck) {
		return reject('illegal-command', `${command.deck} deck cannot draw into zone ${destination.id}`);
	}

	const drawField = command.deck === 'major' ? 'majorDraw' : 'playerDraw';
	const discardField = command.deck === 'major' ? 'majorDiscard' : 'playerDiscard';
	const result = drawWithReshuffle(state[drawField], state[discardField], command.count, ctx.rng);
	if ('insufficient' in result) {
		return reject(
			'illegal-command',
			`insufficient cards to draw ${command.count} from the ${command.deck} deck: ${result.available} available`
		);
	}

	let nextState: SessionEngineStateV1 = { ...state, [drawField]: result.drawPile, [discardField]: result.discardPile };
	const destinationCards = findZoneDescriptor(nextState, destination.id)!.cards.concat(result.drawn);
	nextState = setZoneCards(nextState, destination.id, destinationCards);
	nextState = scheduleFoolReshuffleIfDrawn(nextState, result.drawn);

	const event = buildMoveEvent('card-drawn', destination, ctx.actor, result.drawn, {
		deck: command.deck,
		destinationZoneId: destination.id,
		reshuffled: result.reshuffled
	});
	return { ok: true, state: nextState, events: [event] };
}

export function handleDeal(command: DealCommand, state: SessionEngineStateV1, ctx: CommandHandlerContext): SessionReduceResult {
	const destinations: ZoneDescriptor[] = [];
	for (const id of command.destinationZoneIds) {
		const zone = findZoneDescriptor(state, id);
		if (!zone) return reject('illegal-command', `destination zone not found: ${id}`);
		if (zone.deck !== 'both' && zone.deck !== command.deck) {
			return reject('illegal-command', `${command.deck} deck cannot draw into zone ${zone.id}`);
		}
		destinations.push(zone);
	}

	const drawField = command.deck === 'major' ? 'majorDraw' : 'playerDraw';
	const discardField = command.deck === 'major' ? 'majorDiscard' : 'playerDiscard';

	let drawPile = state[drawField];
	let discardPile = state[discardField];
	let anyReshuffled = false;
	const dealtByZone: Array<{ zoneId: string; cardIds: CardId[] }> = [];

	for (const destination of destinations) {
		const result = drawWithReshuffle(drawPile, discardPile, command.countPerDestination, ctx.rng);
		if ('insufficient' in result) {
			return reject(
				'illegal-command',
				`insufficient cards to deal ${command.countPerDestination} from the ${command.deck} deck: ${result.available} available`
			);
		}
		drawPile = result.drawPile;
		discardPile = result.discardPile;
		anyReshuffled = anyReshuffled || result.reshuffled;
		dealtByZone.push({ zoneId: destination.id, cardIds: result.drawn });
	}

	let nextState: SessionEngineStateV1 = { ...state, [drawField]: drawPile, [discardField]: discardPile };
	for (const { zoneId, cardIds } of dealtByZone) {
		const existing = findZoneDescriptor(nextState, zoneId)!.cards;
		nextState = setZoneCards(nextState, zoneId, existing.concat(cardIds));
	}
	nextState = scheduleFoolReshuffleIfDrawn(nextState, dealtByZone.flatMap((d) => d.cardIds));

	// Indexed pairing, not `dealtByZone.find(...)` — `destinationZoneIds` may
	// legally repeat the same zone (the schema doesn't forbid it), and a
	// lookup-by-id would silently collapse onto the first batch dealt there.
	const privatePayloads: Record<UserId, Array<{ zoneId: string; cardIds: CardId[] }>> = {};
	const publicReveals: Array<{ zoneId: string; cardIds: CardId[] }> = [];
	for (let i = 0; i < destinations.length; i += 1) {
		const destination = destinations[i];
		const dealt = dealtByZone[i];
		const recipient = privateRecipientForZone(destination, ctx.actor);
		if (recipient === undefined) {
			publicReveals.push(dealt);
		} else {
			(privatePayloads[recipient] ??= []).push({ zoneId: destination.id, cardIds: dealt.cardIds });
		}
	}

	const event: SessionEvent = {
		kind: 'cards-dealt',
		publicPayload: {
			deck: command.deck,
			destinationZoneIds: command.destinationZoneIds,
			countPerDestination: command.countPerDestination,
			reshuffled: anyReshuffled,
			revealed: publicReveals
		},
		...(Object.keys(privatePayloads).length > 0 ? { privatePayloads } : {})
	};

	return { ok: true, state: nextState, events: [event] };
}

// ---------------------------------------------------------------------------
// play / place-facedown / discard / transfer / select-from-discard
// ---------------------------------------------------------------------------

interface MoveShapedCommand {
	sourceZoneId: string;
	cardId: CardId;
	destinationZoneId: string;
}

/** Shared handler for the five commands that move one actor-named card
 * between two named zones (`play`, `place-facedown`, `discard`, `transfer`,
 * `select-from-discard`). They share identical `{sourceZoneId, cardId,
 * destinationZoneId}` legality and event shape; only the emitted event
 * `kind` differs, which the spec treats as bookkeeping, not distinct
 * mechanics (§8.3: "Generic table controls use the same commands"). */
export function handleGenericMove(
	eventKind: string,
	command: PlayCommand | PlaceFacedownCommand | DiscardCommand | TransferCommand | SelectFromDiscardCommand,
	state: SessionEngineStateV1,
	ctx: CommandHandlerContext
): SessionReduceResult {
	const move: MoveShapedCommand = command;

	const source = findZoneDescriptor(state, move.sourceZoneId);
	if (!source) return reject('illegal-command', `source zone not found: ${move.sourceZoneId}`);
	const destination = findZoneDescriptor(state, move.destinationZoneId);
	if (!destination) return reject('illegal-command', `destination zone not found: ${move.destinationZoneId}`);

	if (!actorMayAccessZone(ctx.actor, source)) return reject('not-authorized', `actor may not act on zone ${source.id}`);
	if (!actorMayAccessZone(ctx.actor, destination)) {
		return reject('not-authorized', `actor may not act on zone ${destination.id}`);
	}

	const cardEntry = ctx.catalog[move.cardId];
	if (!cardEntry) return reject('content-mismatch', `unrecognized card referenced against zone ${source.id}`);

	if (!source.cards.includes(move.cardId)) {
		return reject('illegal-command', `named card is not present in source zone ${source.id}`);
	}
	if (destination.deck !== 'both' && cardEntry.deck !== destination.deck) {
		return reject('illegal-command', `card's deck does not match destination zone ${destination.id}`);
	}

	const sourceCards = source.cards.filter((id) => id !== move.cardId);
	let nextState = setZoneCards(state, source.id, sourceCards);
	const destinationCards = findZoneDescriptor(nextState, destination.id)!.cards.concat(move.cardId);
	nextState = setZoneCards(nextState, destination.id, destinationCards);

	const event = buildMoveEvent(eventKind, destination, ctx.actor, [move.cardId], {
		sourceZoneId: source.id,
		destinationZoneId: destination.id
	});
	return { ok: true, state: nextState, events: [event] };
}

// ---------------------------------------------------------------------------
// reveal
// ---------------------------------------------------------------------------

/** `reveal` never moves the card — it announces the identity of a card that
 * stays exactly where it is. Its whole purpose is disclosure, so (unlike the
 * move commands) its public event always carries the card id once
 * authorization and presence are confirmed. */
export function handleReveal(command: RevealCommand, state: SessionEngineStateV1, ctx: CommandHandlerContext): SessionReduceResult {
	const zone = findZoneDescriptor(state, command.zoneId);
	if (!zone) return reject('illegal-command', `zone not found: ${command.zoneId}`);
	if (!actorMayAccessZone(ctx.actor, zone)) return reject('not-authorized', `actor may not act on zone ${zone.id}`);
	if (!ctx.catalog[command.cardId]) return reject('content-mismatch', `unrecognized card referenced against zone ${zone.id}`);
	if (!zone.cards.includes(command.cardId)) {
		return reject('illegal-command', `named card is not present in zone ${zone.id}`);
	}

	const event: SessionEvent = {
		kind: 'card-revealed',
		publicPayload: { zoneId: zone.id, cardId: command.cardId }
	};
	return { ok: true, state, events: [event] };
}

// ---------------------------------------------------------------------------
// reorder-top
// ---------------------------------------------------------------------------

function sameCardMultiset(a: readonly CardId[], b: readonly CardId[]): boolean {
	if (a.length !== b.length) return false;
	return [...a].sort().join(' ') === [...b].sort().join(' ');
}

export function handleReorderTop(
	command: ReorderTopCommand,
	state: SessionEngineStateV1,
	ctx: CommandHandlerContext
): SessionReduceResult {
	const zone = findZoneDescriptor(state, command.zoneId);
	if (!zone) return reject('illegal-command', `zone not found: ${command.zoneId}`);
	if (!zone.ordered) return reject('illegal-command', `zone ${zone.id} has no meaningful order to reorder`);
	if (!actorMayAccessZone(ctx.actor, zone)) return reject('not-authorized', `actor may not act on zone ${zone.id}`);

	for (const cardId of command.cardIds) {
		if (!ctx.catalog[cardId]) return reject('content-mismatch', `unrecognized card referenced against zone ${zone.id}`);
	}

	const currentTop = zone.cards.slice(0, command.cardIds.length);
	if (!sameCardMultiset(currentTop, command.cardIds)) {
		return reject('illegal-command', `reorder set does not match the top ${command.cardIds.length} card(s) of zone ${zone.id}`);
	}

	const nextCards = command.cardIds.concat(zone.cards.slice(command.cardIds.length));
	const nextState = setZoneCards(state, zone.id, nextCards);

	const recipient = privateRecipientForZone(zone, ctx.actor);
	const event: SessionEvent =
		recipient === undefined
			? { kind: 'zone-reordered', publicPayload: { zoneId: zone.id, cardIds: command.cardIds } }
			: {
					kind: 'zone-reordered',
					publicPayload: { zoneId: zone.id, count: command.cardIds.length },
					privatePayloads: { [recipient]: { zoneId: zone.id, cardIds: command.cardIds } }
				};
	return { ok: true, state: nextState, events: [event] };
}

// ---------------------------------------------------------------------------
// mulligan
// ---------------------------------------------------------------------------

/** Discards every card currently in `zoneId` and draws the same count of
 * replacements from that zone's deck (spec §8.6: GM mulligan). Deck-exhausted
 * redraws reshuffle exactly like `draw`. */
export function handleMulligan(command: MulliganCommand, state: SessionEngineStateV1, ctx: CommandHandlerContext): SessionReduceResult {
	const zone = findZoneDescriptor(state, command.zoneId);
	if (!zone) return reject('illegal-command', `zone not found: ${command.zoneId}`);
	if (zone.deck === 'both') return reject('illegal-command', `zone ${zone.id} has no single deck to mulligan against`);
	if (!actorMayAccessZone(ctx.actor, zone)) return reject('not-authorized', `actor may not act on zone ${zone.id}`);

	const drawField = zone.deck === 'major' ? 'majorDraw' : 'playerDraw';
	const discardField = zone.deck === 'major' ? 'majorDiscard' : 'playerDiscard';
	if (zone.id === drawField || zone.id === discardField) {
		// A deck's own draw/discard pile can't mulligan against itself — "old
		// cards" and the replacement source would be the same pile, which
		// would double-count cards rather than conserve them.
		return reject('illegal-command', `zone ${zone.id} cannot mulligan against its own deck pile`);
	}
	const oldCards = zone.cards.slice();
	const discardPileWithOld = state[discardField].concat(oldCards);

	const result =
		oldCards.length === 0
			? { drawn: [] as CardId[], drawPile: state[drawField], discardPile: discardPileWithOld, reshuffled: false }
			: drawWithReshuffle(state[drawField], discardPileWithOld, oldCards.length, ctx.rng);
	/* v8 ignore start -- unreachable: `discardPileWithOld` already contains
	 * all `oldCards.length` cards this redraw is trying to satisfy, so
	 * draw + discard together can never be short. Kept only so this
	 * branch narrows `result`'s type away from `DrawInsufficientResult`. */
	if ('insufficient' in result) {
		return reject(
			'illegal-command',
			`insufficient cards to mulligan ${oldCards.length} from the ${zone.deck} deck: ${result.available} available`
		);
	}
	/* v8 ignore stop */

	let nextState: SessionEngineStateV1 = {
		...state,
		[drawField]: result.drawPile,
		[discardField]: result.discardPile
	};
	nextState = setZoneCards(nextState, zone.id, result.drawn);
	nextState = scheduleFoolReshuffleIfDrawn(nextState, result.drawn);

	const recipient = privateRecipientForZone(zone, ctx.actor);
	const event: SessionEvent =
		recipient === undefined
			? {
					kind: 'zone-mulliganed',
					publicPayload: { zoneId: zone.id, count: oldCards.length, reshuffled: result.reshuffled, cardIds: result.drawn }
				}
			: {
					kind: 'zone-mulliganed',
					publicPayload: { zoneId: zone.id, count: oldCards.length, reshuffled: result.reshuffled },
					privatePayloads: { [recipient]: { zoneId: zone.id, discardedCardIds: oldCards, drawnCardIds: result.drawn } }
				};
	return { ok: true, state: nextState, events: [event] };
}

// ---------------------------------------------------------------------------
// procedure lifecycle / end-round / apply-correction
// ---------------------------------------------------------------------------

export function handleBeginProcedure(
	command: BeginProcedureCommand,
	state: SessionEngineStateV1,
	_ctx: CommandHandlerContext
): SessionReduceResult {
	if (state.procedure !== null) return reject('illegal-command', 'a procedure is already active');

	const nextState: SessionEngineStateV1 = {
		...state,
		procedure: { procedureId: command.procedureId, stepIndex: 0, pendingZoneIds: [] }
	};
	const event: SessionEvent = { kind: 'procedure-begun', publicPayload: { procedureId: command.procedureId } };
	return { ok: true, state: nextState, events: [event] };
}

export function handleAdvanceProcedure(
	command: AdvanceProcedureCommand,
	state: SessionEngineStateV1,
	_ctx: CommandHandlerContext
): SessionReduceResult {
	if (!state.procedure || state.procedure.procedureId !== command.procedureId) {
		return reject('illegal-command', `no active procedure matches ${command.procedureId}`);
	}

	const nextStepIndex = state.procedure.stepIndex + 1;
	const nextState: SessionEngineStateV1 = { ...state, procedure: { ...state.procedure, stepIndex: nextStepIndex } };
	const event: SessionEvent = {
		kind: 'procedure-advanced',
		publicPayload: { procedureId: command.procedureId, stepIndex: nextStepIndex }
	};
	return { ok: true, state: nextState, events: [event] };
}

export function handleCompleteProcedure(
	command: CompleteProcedureCommand,
	state: SessionEngineStateV1,
	_ctx: CommandHandlerContext
): SessionReduceResult {
	if (!state.procedure || state.procedure.procedureId !== command.procedureId) {
		return reject('illegal-command', `no active procedure matches ${command.procedureId}`);
	}

	const nextState: SessionEngineStateV1 = { ...state, procedure: null };
	const event: SessionEvent = { kind: 'procedure-completed', publicPayload: { procedureId: command.procedureId } };
	return { ok: true, state: nextState, events: [event] };
}

/** Applies any decks scheduled for reshuffle by a Fool draw (spec §8.4's
 * "end of the … round or the guided procedure's explicit round/boundary" —
 * Task 2's generic engine only knows the `end-round` boundary; procedure
 * modules add their own boundaries later). */
export function handleEndRound(
	_command: EndRoundCommand,
	state: SessionEngineStateV1,
	ctx: CommandHandlerContext
): SessionReduceResult {
	let nextState = state;
	const reshuffledDecks: Array<'major' | 'player'> = [];

	if (state.reshuffleAtBoundary.major) {
		const { drawPile, discardPile } = reshuffleDeck(nextState.majorDraw, nextState.majorDiscard, ctx.rng);
		nextState = {
			...nextState,
			majorDraw: drawPile,
			majorDiscard: discardPile,
			reshuffleAtBoundary: { ...nextState.reshuffleAtBoundary, major: false }
		};
		reshuffledDecks.push('major');
	}
	if (state.reshuffleAtBoundary.player) {
		const { drawPile, discardPile } = reshuffleDeck(nextState.playerDraw, nextState.playerDiscard, ctx.rng);
		nextState = {
			...nextState,
			playerDraw: drawPile,
			playerDiscard: discardPile,
			reshuffleAtBoundary: { ...nextState.reshuffleAtBoundary, player: false }
		};
		reshuffledDecks.push('player');
	}

	const event: SessionEvent = { kind: 'round-ended', publicPayload: { reshuffledDecks } };
	return { ok: true, state: nextState, events: [event] };
}

/** A GM-only audit annotation. Task 2's generic engine has no registry of
 * "what a correction repairs" — the actual repair is a normal command (e.g. a
 * GM `transfer`); `apply-correction` only records why, tied to the event it
 * compensates for. It never rewrites state itself. */
export function handleApplyCorrection(
	command: ApplyCorrectionCommand,
	state: SessionEngineStateV1,
	_ctx: CommandHandlerContext
): SessionReduceResult {
	const event: SessionEvent = {
		kind: 'correction-applied',
		publicPayload: { targetEventId: command.targetEventId, note: command.note }
	};
	return { ok: true, state, events: [event] };
}
