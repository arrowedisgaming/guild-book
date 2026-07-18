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
import type {
	SessionModifierDefinition,
	TarotConfig,
	TarotProcedureDefinition
} from '$lib/types/content-pack';

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
 * to verify deck ownership and set completeness; it only ever reads `id` and
 * `deck`, so those two fields remain the minimum any catalog entry must
 * carry (see `tests/fixtures/session.ts`'s `{id, deck}`-only fixture). The
 * remaining fields are what Task 4's compiler (`compileSessionRuntimeContent`
 * in `$lib/server/content/session-runtime.ts`) additionally hydrates from the
 * content pack's tarot config so projections can show real labels/art/suit/
 * rank/major metadata instead of falling back to the card id — see
 * `src/lib/engine/session/projection.ts`'s `hydrateVisible`.
 */
export interface TarotCardCatalogEntry {
	id: CardId;
	deck: 'major' | 'player';
	label?: string;
	imageKey?: string;
	value?: number;
	suit?: SuitId;
	rank?: RankId;
	major?: { number: number; name: string; doomTier?: DoomTier; valueParity: ValueParity };
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

/** Just the discriminant — used by projections to list which command types
 * an actor may currently attempt (`legalCommandsForActor`), without needing
 * a full command payload. */
export type SessionCommandType = SessionCommand['type'];

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
 * The public "card-back projection" of one private face-down/prepared zone
 * (spec §8.2: "private face-down or prepared areas with a public card-back
 * projection"). `cards` is always `HiddenCardSlot[]` here — one opaque back
 * per card, so viewers can see *how many* and where, never identities. This
 * is shared verbatim across every role's projection (including the zone's
 * own owner); an owner sees their own real identities separately, via
 * `SessionPlayerProjection.privateFacedown`/`privatePrepared`.
 */
export interface PublicPrivateZoneCardBacks {
	id: string;
	kind: 'player-facedown' | 'player-prepared';
	ownerUserId: UserId;
	cards: HiddenCardSlot[];
}

/**
 * Everyone at the table sees this. `playerHandCounts` is public information
 * (spec §8.2) — hand counts never move to a private section. Session
 * lifecycle status (active/frozen/ended) is deliberately absent: the pure
 * engine state has no such field (it's a persistence concern the Task 5
 * command service tracks alongside/inside the envelope it returns), so the
 * pure projector must not fabricate one.
 */
export interface SessionPublicProjection {
	sessionId: string;
	version: number;
	phase: SessionPhase;
	procedure: PublicProcedureView | null;
	majorDrawCount: number;
	majorDiscardTop: CardSlot | null;
	playerDrawCount: number;
	playerDiscardTop: CardSlot | null;
	gmHandCount: number;
	playerHandCounts: Record<UserId, number>;
	privateZoneCardBacks: PublicPrivateZoneCardBacks[];
	publicZones: PublicSessionZoneView[];
	pendingZoneCounts: Array<{ id: string; deck: 'major' | 'player'; count: number }>;
}

/** A player's projection: the shared public view plus only that player's own
 * private identities, plus the command types they may currently attempt
 * (`legalCommandsForActor` — coarse, role-based; a specific command instance
 * can still be rejected on its own zone/card legality). */
export interface SessionPlayerProjection {
	public: SessionPublicProjection;
	privateHand: CardSlot[];
	privateFacedown: CardSlot[];
	privatePrepared: CardSlot[];
	legalCommands: SessionCommandType[];
}

/** The GM's projection: the shared public view plus only the GM hand and
 * GM-private procedure detail, plus the command types the GM may currently
 * attempt. Never a player's private identities. */
export interface SessionGmProjection {
	public: SessionPublicProjection;
	gmHand: CardSlot[];
	gmPrivateProcedure?: unknown;
	legalCommands: SessionCommandType[];
}

// ---------------------------------------------------------------------------
// Session runtime content (Task 4). A single immutable, digest-stamped
// snapshot of every game rule a live session needs — tarot config, the
// in-session procedure catalog, the full card catalog, and their modifiers —
// compiled from the content pack and pinned to `sessionRuntimeContents` at
// session start (see `src/lib/server/db/schema.ts`). A mid-campaign
// content-pack update must never change a live session's rules, so the
// command service (Task 5) always loads this pinned document rather than the
// live bundle. Compiled by `compileSessionRuntimeContent` in
// `$lib/server/content/session-runtime.ts`; validated against
// `sessionRuntimeContentV1Schema` (`$lib/schemas/session-runtime.schema.ts`)
// both before insert and after every read. Deliberately excludes
// `TarotProceduresFile`'s `lookupTables`/`formulas` collections — those are
// rule reference data, not state a live command needs to resolve; only what
// procedures/modifiers/cards actually carry belongs here (no speculative or
// unrelated rule prose).
export interface SessionRuntimeContentV1 {
	schemaVersion: 1;
	contentPackId: string;
	contentPackVersion: string;
	/** SHA-256 (hex) over every other field via the stable-key canonical
	 * serializer in `$lib/server/content/canonical-json.ts`. */
	contentDigest: string;
	tarot: TarotConfig;
	procedures: TarotProcedureDefinition[];
	cards: TarotCardCatalogEntry[];
	modifiers: SessionModifierDefinition[];
}
