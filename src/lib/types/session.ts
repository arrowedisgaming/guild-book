/**
 * Types for the server-authoritative shared tarot table (campaign sessions).
 *
 * `SessionEngineStateV1` is the complete, server-only state of an active
 * session's cards: two decks, their discards, the GM hand, every private
 * player zone, public table zones, and procedure-owned pending zones. At
 * every version, each of the catalog's configured cards lives in exactly one
 * zone — see `src/lib/engine/session/invariants.ts`.
 *
 * The frozen envelope/rejection contract below is copied verbatim from the
 * roadmap's Cross-Increment Contract Freeze and must not be altered by later
 * tasks without a corresponding roadmap amendment.
 */

import type { SuitId, RankId } from '$lib/types/common';

export type CardId = string;
export type UserId = string;

/** Which Doom abilities a major can activate. Duplicated locally (not
 * imported from the engine layer) so this pure type module has no
 * `$lib/engine` dependency. */
export type DoomTier = 'lesser' | 'greater';
export type ValueParity = 'odd' | 'even';

/**
 * A private zone owned by a single player. Addressed by `id` (not by owner +
 * kind) because a player can hold more than one zone of the same kind — e.g.
 * multiple face-down effects — and later increments (Increment 3's
 * `cardZoneId`) address zones individually.
 */
export interface OwnedPrivateZone {
	id: string;
	kind: 'player-hand' | 'player-facedown' | 'player-prepared';
	ownerUserId: UserId;
	cards: CardId[];
}

/** A public zone visible to every session participant. */
export interface PublicZone {
	id: string;
	kind: 'initiative' | 'played' | 'revealed' | 'inspiration';
	cards: CardId[];
}

/** A procedure-owned pending/selection zone (e.g. a reorder-top selection). */
export interface PendingZone {
	id: string;
	deck: 'major' | 'player';
	cards: CardId[];
}

/**
 * Minimal v1 procedure state. `gmPrivate` carries data that must never reach
 * a player or public projection. Increment 3 extends this; keep it lean here.
 */
export type ProcedureState = {
	procedureId: string;
	stepIndex: number;
	pendingZoneIds: string[];
	gmPrivate?: unknown;
} | null;

export interface SessionEngineStateV1 {
	schemaVersion: 1;
	sessionId: string;
	version: number;
	phase: 'crawl' | 'challenge' | 'camp' | 'city';
	procedure: ProcedureState;
	majorDraw: CardId[];
	majorDiscard: CardId[];
	playerDraw: CardId[];
	playerDiscard: CardId[];
	gmHand: CardId[];
	privateZones: OwnedPrivateZone[];
	publicZones: PublicZone[];
	pendingZones: PendingZone[];
	reshuffleAtBoundary: { major: boolean; player: boolean };
}

/** Who is issuing a session command. Supplied by server-side auth context,
 * never trusted from the client payload. */
export type SessionActor = { kind: 'gm'; userId: UserId } | { kind: 'player'; userId: UserId };

/**
 * Lookup of every configured tarot card. The invariant checker consumes this
 * to verify deck ownership and set completeness. Task 4 builds the full
 * runtime catalog entry type (art, labels, etc.); this stays minimal.
 */
export interface TarotCardCatalogEntry {
	id: CardId;
	deck: 'major' | 'player';
}
export type TarotCardCatalog = Record<CardId, TarotCardCatalogEntry>;

// ---------------------------------------------------------------------------
// Command vocabulary (spec §8.3). Card-moving commands identify a source zone
// and an actor-owned card selection; `draw`/`deal` specify only a count and a
// destination and never carry a card ID — the server chooses which card(s)
// come off the top.
// ---------------------------------------------------------------------------

export interface DrawCommand {
	type: 'draw';
	deck: 'major' | 'player';
	destinationZoneId: string;
	count: number;
}

export interface DealCommand {
	type: 'deal';
	deck: 'major' | 'player';
	destinationZoneIds: string[];
	countPerDestination: number;
}

export interface PlayCommand {
	type: 'play';
	sourceZoneId: string;
	cardId: CardId;
	destinationZoneId: string;
}

export interface PlaceFacedownCommand {
	type: 'place-facedown';
	sourceZoneId: string;
	cardId: CardId;
	destinationZoneId: string;
}

export interface RevealCommand {
	type: 'reveal';
	zoneId: string;
	cardId: CardId;
}

export interface DiscardCommand {
	type: 'discard';
	sourceZoneId: string;
	cardId: CardId;
	destinationZoneId: string;
}

export interface TransferCommand {
	type: 'transfer';
	sourceZoneId: string;
	cardId: CardId;
	destinationZoneId: string;
}

export interface SelectFromDiscardCommand {
	type: 'select-from-discard';
	sourceZoneId: string;
	cardId: CardId;
	destinationZoneId: string;
}

export interface ReorderTopCommand {
	type: 'reorder-top';
	zoneId: string;
	cardIds: CardId[];
}

export interface MulliganCommand {
	type: 'mulligan';
	zoneId: string;
}

export interface BeginProcedureCommand {
	type: 'begin-procedure';
	procedureId: string;
}

export interface AdvanceProcedureCommand {
	type: 'advance-procedure';
	procedureId: string;
}

export interface CompleteProcedureCommand {
	type: 'complete-procedure';
	procedureId: string;
}

export interface EndRoundCommand {
	type: 'end-round';
}

/** A GM-only compensating command. Never rewrites history; always a new
 * event layered on top. */
export interface ApplyCorrectionCommand {
	type: 'apply-correction';
	targetEventId: string;
	note: string;
}

export type SessionCommand =
	| DrawCommand
	| DealCommand
	| PlayCommand
	| PlaceFacedownCommand
	| RevealCommand
	| DiscardCommand
	| TransferCommand
	| SelectFromDiscardCommand
	| ReorderTopCommand
	| MulliganCommand
	| BeginProcedureCommand
	| AdvanceProcedureCommand
	| CompleteProcedureCommand
	| EndRoundCommand
	| ApplyCorrectionCommand;

// ---------------------------------------------------------------------------
// Frozen contracts (roadmap Cross-Increment Contract Freeze). Copied verbatim
// — do NOT use a single-field `observedVersion` form anywhere.
// ---------------------------------------------------------------------------

export type SessionStatus = 'active' | 'frozen' | 'ended';
export type SessionPhase = 'crawl' | 'challenge' | 'camp' | 'city';

export interface SessionCommandEnvelope<C> {
	commandId: string;
	/** Advisory freshness hint for the UI. NOT a precondition — see §10.2. */
	observedSessionVersion: number;
	/** Required only for structural intents: advance/complete procedure, end round,
	 *  end session, apply correction. This is the hard precondition. */
	expectedStructuralVersion?: number;
	/** Present only on resource-spend commands (pre-test Resolve for favor). */
	observedCharacterVersion?: number;
	command: C;
}

export interface SessionProjectionEnvelope<P> {
	campaignCursor: number;
	sessionVersion: number;
	projection: P;
}

export type CommandRejectionCode =
	| 'not-authorized'
	| 'illegal-command'
	| 'stale-structure'
	| 'command-id-reused'
	| 'content-mismatch'
	| 'retry-exhausted';

/** A rejected command. Carries only counts/zone ids in `message` — never a
 * hidden card id. */
export interface SessionRejection {
	code: CommandRejectionCode;
	message: string;
}

/**
 * An engine-emitted event: a public payload every participant may receive,
 * plus optional per-recipient private payloads for the actor(s) who need the
 * hidden detail (e.g. which card they drew). Kept lean — Task 2 emits these.
 */
export interface SessionEvent {
	kind: string;
	publicPayload: unknown;
	privatePayloads?: Record<UserId, unknown>;
}

// ---------------------------------------------------------------------------
// Projections. Hidden slots surface as `{ hidden: true }` and carry none of
// `id`, `label`, `imageKey`, `value`, `suit`, `rank`, or major metadata — the
// concealed card's identity must not be derivable from the slot shape.
// ---------------------------------------------------------------------------

export interface HiddenCardSlot {
	hidden: true;
}

export interface VisibleCardSlot {
	hidden: false;
	id: CardId;
	label: string;
	imageKey: string;
	value: number;
	suit?: SuitId;
	rank?: RankId;
	major?: { number: number; name: string; doomTier?: DoomTier; valueParity: ValueParity };
}

export type CardSlot = HiddenCardSlot | VisibleCardSlot;

export interface PublicProcedureView {
	procedureId: string;
	stepIndex: number;
	pendingZoneIds: string[];
}

export interface PublicSessionZoneView {
	id: string;
	kind: 'initiative' | 'played' | 'revealed' | 'inspiration';
	cards: CardSlot[];
}

/**
 * Everyone at the table sees this. `playerHandCounts` is public information
 * (spec §8.2) — hand counts never move to a private section.
 */
export interface SessionPublicProjection {
	sessionId: string;
	version: number;
	phase: SessionPhase;
	status: SessionStatus;
	procedure: PublicProcedureView | null;
	majorDrawCount: number;
	majorDiscardTop: CardSlot | null;
	playerDrawCount: number;
	playerDiscardTop: CardSlot | null;
	gmHandCount: number;
	playerHandCounts: Record<UserId, number>;
	publicZones: PublicSessionZoneView[];
	pendingZoneCounts: Array<{ id: string; deck: 'major' | 'player'; count: number }>;
}

/** A player's projection: the shared public view plus only that player's own
 * private identities. */
export interface SessionPlayerProjection {
	public: SessionPublicProjection;
	privateHand: CardSlot[];
	privateFacedown: CardSlot[];
	privatePrepared: CardSlot[];
}

/** The GM's projection: the shared public view plus only the GM hand and
 * GM-private procedure detail. Never a player's private identities. */
export interface SessionGmProjection {
	public: SessionPublicProjection;
	gmHand: CardSlot[];
	gmPrivateProcedure?: unknown;
}
