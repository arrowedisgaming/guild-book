/**
 * Fragment load/store SQL for the shared tarot table (Task 5). Owns:
 *
 * - Splitting a full `SessionEngineStateV1` into the three persisted
 *   fragments (public/server/per-recipient-private — spec §6.4-6.6) and
 *   reassembling them back into one state for the reducer.
 * - Resolving a campaign member's `SessionActor` role.
 * - Building the parameterized `AtomicStatement` lists `command-service.ts`/
 *   `lifecycle.ts` hand to `runAtomic` (`$lib/server/db/atomic.ts`).
 *
 * Reads go through the ordinary Drizzle query surface (`AppDb`); writes are
 * always plain `{sql, params}` statements — never Drizzle statements — so
 * every write in this module can be batched atomically on both SQLite and D1
 * (see `db/atomic.ts`'s file header for why Drizzle statements can't do
 * this for the campaign-event id assignment below).
 */

import { and, eq, isNull, max } from 'drizzle-orm';
import { z } from 'zod';
import type { AppDb } from '$lib/server/db';
import type { AtomicStatement } from '$lib/server/db/atomic';
import { statement } from '$lib/server/db/atomic';
import {
	campaignEvents,
	campaignMembers,
	campaigns,
	sessionCommands,
	sessionPrivateStates,
	sessionRuntimeContents,
	sessionServerStates,
	playSessions
} from '$lib/server/db/schema';
import { ownedPrivateZoneSchema, pendingZoneSchema, publicZoneSchema, sessionPhaseSchema } from '$lib/schemas/session.schema';
import { parseSessionRuntimeContent } from '$lib/server/content/session-runtime';
import { canonicalDigest } from '$lib/server/content/canonical-json';
import type {
	CardId,
	OwnedPrivateZone,
	PendingZone,
	PublicZone,
	SessionActor,
	SessionEngineStateV1,
	SessionEvent,
	SessionPhase,
	SessionRejection,
	SessionRuntimeContentV1,
	SessionStatus,
	UserId
} from '$lib/types/session';

// ---------------------------------------------------------------------------
// Fragment shapes. Each carries its own `schemaVersion` so a future migration
// can be detected on read (amendment 5: "fragment schema-version mismatch on
// load = unexpected load failure"). Together the three fragments are a
// lossless, non-overlapping partition of `SessionEngineStateV1` — every field
// lives in exactly one fragment.
// ---------------------------------------------------------------------------

/** Everything any session participant may see: `playSessions.publicStateJson`. */
export interface SessionPublicFragmentV1 {
	schemaVersion: 1;
	publicZones: PublicZone[];
	procedurePublic: { procedureId: string; stepIndex: number; pendingZoneIds: string[] } | null;
}

/** Secret data owned by no single recipient: `sessionServerStates.serverStateJson`. */
export interface SessionServerFragmentV1 {
	schemaVersion: 1;
	majorDraw: CardId[];
	majorDiscard: CardId[];
	playerDraw: CardId[];
	playerDiscard: CardId[];
	pendingZones: PendingZone[];
	reshuffleAtBoundary: { major: boolean; player: boolean };
	/** Cryptographically random hex seed generated at session start (amendment
	 * 10). Recovery state only — never exposed in any projection, event, or
	 * error. `deriveAttemptSeed` (`command-service.ts`) is the only reader. */
	shuffleSeed: string;
}

/** One recipient's private zones: one `sessionPrivateStates` row per
 * `(sessionId, recipientUserId)`. The session's GM recipient row additionally
 * carries `gmHand`/`gmPrivateProcedure` — those two fields belong to the GM
 * as a *recipient*, not to the server fragment, matching the "never a
 * combined secret blob" rule the doc comments on `sessionPrivateStates` and
 * `sessionServerStates` already establish. */
export interface SessionPrivateFragmentV1 {
	schemaVersion: 1;
	zones: OwnedPrivateZone[];
	gmHand?: CardId[];
	gmPrivateProcedure?: unknown;
}

const sessionPublicFragmentSchema = z
	.object({
		schemaVersion: z.literal(1),
		publicZones: z.array(publicZoneSchema),
		procedurePublic: z
			.object({
				procedureId: z.string(),
				stepIndex: z.number().int().nonnegative(),
				pendingZoneIds: z.array(z.string())
			})
			.nullable()
	})
	.strict();

const sessionServerFragmentSchema = z
	.object({
		schemaVersion: z.literal(1),
		majorDraw: z.array(z.string()),
		majorDiscard: z.array(z.string()),
		playerDraw: z.array(z.string()),
		playerDiscard: z.array(z.string()),
		pendingZones: z.array(pendingZoneSchema),
		reshuffleAtBoundary: z.object({ major: z.boolean(), player: z.boolean() }),
		shuffleSeed: z.string().min(1)
	})
	.strict();

const sessionPrivateFragmentSchema = z
	.object({
		schemaVersion: z.literal(1),
		zones: z.array(ownedPrivateZoneSchema),
		gmHand: z.array(z.string()).optional(),
		gmPrivateProcedure: z.unknown().optional()
	})
	.strict();

/** Thrown by `loadSessionForReduce` on any integrity failure that means the
 * persisted fragments can no longer be trusted to reassemble a valid engine
 * state: a pinned-content digest mismatch, a fragment that fails its own
 * schema, or fragments loaded at inconsistent session versions. The command
 * service catches this specifically to trigger the freeze path (amendment 5
 * / brief Step 4's last paragraph). Never carries card identities — only
 * table/column-level description. */
export class SessionLoadIntegrityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SessionLoadIntegrityError';
	}
}

export class SessionNotFoundError extends Error {
	constructor(sessionId: string) {
		super(`session not found: ${sessionId}`);
		this.name = 'SessionNotFoundError';
	}
}

// ---------------------------------------------------------------------------
// Actor resolution
// ---------------------------------------------------------------------------

/** Resolves `userId`'s role for `campaignId`: the campaign's immutable owner
 * is always the GM; an active (not left/removed) member is a player; anyone
 * else is not authorized. Mirrors `$lib/server/campaign/access.ts`'s
 * `resolveCampaignAccess` role logic without that module's `RequestEvent`/
 * `error()` HTTP coupling — this layer never throws HTTP status codes
 * (Task 6 maps rejection codes to HTTP). */
export async function resolveSessionActor(
	db: AppDb,
	campaignId: string,
	userId: string
): Promise<SessionActor | null> {
	const row = await db
		.select({ ownerUserId: campaigns.ownerUserId, membershipId: campaignMembers.id })
		.from(campaigns)
		.leftJoin(
			campaignMembers,
			and(
				eq(campaignMembers.campaignId, campaigns.id),
				eq(campaignMembers.userId, userId),
				isNull(campaignMembers.leftAt),
				isNull(campaignMembers.removedAt)
			)
		)
		.where(eq(campaigns.id, campaignId))
		.get();
	if (!row) return null;
	if (row.ownerUserId === userId) return { kind: 'gm', userId };
	if (row.membershipId) return { kind: 'player', userId };
	return null;
}

/** Active (not left/removed) member user ids for `campaignId`, used only at
 * session start to seed one private-state recipient row per player. */
export async function listActiveCampaignMemberUserIds(db: AppDb, campaignId: string): Promise<string[]> {
	const rows = await db
		.select({ userId: campaignMembers.userId })
		.from(campaignMembers)
		.where(and(eq(campaignMembers.campaignId, campaignId), isNull(campaignMembers.leftAt), isNull(campaignMembers.removedAt)));
	return rows.map((row) => row.userId);
}

// ---------------------------------------------------------------------------
// Session summary / full reduce-ready load
// ---------------------------------------------------------------------------

export interface SessionSummary {
	sessionId: string;
	campaignId: string;
	status: SessionStatus;
	version: number;
	gmUserId: string;
}

/** Lightweight load for lifecycle actions (freeze/recover/end) that don't
 * run the reducer and so don't need the full fragment reassembly below. */
export async function loadSessionSummary(db: AppDb, sessionId: string): Promise<SessionSummary | null> {
	const row = await db
		.select({
			sessionId: playSessions.id,
			campaignId: playSessions.campaignId,
			status: playSessions.status,
			version: playSessions.version,
			gmUserId: campaigns.ownerUserId
		})
		.from(playSessions)
		.innerJoin(campaigns, eq(campaigns.id, playSessions.campaignId))
		.where(eq(playSessions.id, sessionId))
		.get();
	if (!row) return null;
	return { ...row, status: row.status as SessionStatus };
}

export interface LoadedSession {
	sessionId: string;
	campaignId: string;
	status: SessionStatus;
	currentVersion: number;
	gmUserId: string;
	recipientUserIds: string[];
	engineState: SessionEngineStateV1;
	runtimeContent: SessionRuntimeContentV1;
	shuffleSeed: string;
}

/**
 * Loads every fragment for `sessionId` — pinned runtime, public, server, and
 * every recipient's private fragment — validates each, and reassembles the
 * full `SessionEngineStateV1` the pure reducer needs. Throws
 * `SessionLoadIntegrityError` (freeze-worthy) if the pinned content's digest
 * no longer matches, or any fragment fails its own schema, or the server/
 * private fragments weren't all persisted at the same session version (the
 * "load all fragments at one session version" requirement — brief Step 4
 * item 4; the runtime content is immutable once pinned, so it's excluded
 * from that version-equality check and instead digest-verified).
 */
export async function loadSessionForReduce(db: AppDb, sessionId: string): Promise<LoadedSession> {
	const session = await db.select().from(playSessions).where(eq(playSessions.id, sessionId)).get();
	if (!session) throw new SessionNotFoundError(sessionId);

	const gmRow = await db
		.select({ ownerUserId: campaigns.ownerUserId })
		.from(campaigns)
		.where(eq(campaigns.id, session.campaignId))
		.get();
	if (!gmRow) throw new SessionLoadIntegrityError(`campaign not found for session ${sessionId}`);

	const runtimeRow = await db
		.select()
		.from(sessionRuntimeContents)
		.where(eq(sessionRuntimeContents.sessionId, sessionId))
		.get();
	if (!runtimeRow) throw new SessionLoadIntegrityError(`missing pinned runtime content for session ${sessionId}`);

	let runtimeContent: SessionRuntimeContentV1;
	try {
		runtimeContent = parseSessionRuntimeContent(JSON.parse(runtimeRow.runtimeContentJson));
	} catch (cause) {
		throw new SessionLoadIntegrityError(`pinned runtime content failed validation for session ${sessionId}: ${describeCause(cause)}`);
	}
	if (runtimeContent.contentDigest !== session.contentDigest) {
		throw new SessionLoadIntegrityError(`pinned runtime content digest mismatch for session ${sessionId}`);
	}

	const serverRow = await db.select().from(sessionServerStates).where(eq(sessionServerStates.sessionId, sessionId)).get();
	if (!serverRow) throw new SessionLoadIntegrityError(`missing server state fragment for session ${sessionId}`);
	if (serverRow.sessionVersion !== session.version) {
		throw new SessionLoadIntegrityError(`server state fragment is at a different version than session ${sessionId}`);
	}
	const serverFragment = parseFragment(sessionServerFragmentSchema, serverRow.serverStateJson, 'server state', sessionId);

	const privateRows = await db.select().from(sessionPrivateStates).where(eq(sessionPrivateStates.sessionId, sessionId));
	const privateFragmentsByRecipient = new Map<UserId, SessionPrivateFragmentV1>();
	for (const row of privateRows) {
		if (row.sessionVersion !== session.version) {
			throw new SessionLoadIntegrityError(`private state fragment is at a different version than session ${sessionId}`);
		}
		privateFragmentsByRecipient.set(
			row.recipientUserId,
			parseFragment(sessionPrivateFragmentSchema, row.privateStateJson, 'private state', sessionId)
		);
	}

	const publicFragment = parseFragment(sessionPublicFragmentSchema, session.publicStateJson, 'public state', sessionId);

	const engineState = reassembleEngineState({
		sessionId,
		version: session.version,
		phase: sessionPhaseSchema.parse(session.phase),
		publicFragment,
		serverFragment,
		privateFragmentsByRecipient,
		gmUserId: gmRow.ownerUserId
	});

	return {
		sessionId,
		campaignId: session.campaignId,
		status: session.status as SessionStatus,
		currentVersion: session.version,
		gmUserId: gmRow.ownerUserId,
		recipientUserIds: [...privateFragmentsByRecipient.keys()],
		engineState,
		runtimeContent,
		shuffleSeed: serverFragment.shuffleSeed
	};
}

function parseFragment<T>(schema: z.ZodType<T>, json: string, label: string, sessionId: string): T {
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(json);
	} catch (cause) {
		throw new SessionLoadIntegrityError(`${label} fragment is not valid JSON for session ${sessionId}: ${describeCause(cause)}`);
	}
	const result = schema.safeParse(parsedJson);
	if (!result.success) {
		throw new SessionLoadIntegrityError(`${label} fragment failed schema validation for session ${sessionId}`);
	}
	return result.data;
}

function describeCause(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function reassembleEngineState(input: {
	sessionId: string;
	version: number;
	phase: SessionPhase;
	publicFragment: SessionPublicFragmentV1;
	serverFragment: SessionServerFragmentV1;
	privateFragmentsByRecipient: Map<UserId, SessionPrivateFragmentV1>;
	gmUserId: string;
}): SessionEngineStateV1 {
	const privateZones: OwnedPrivateZone[] = [];
	let gmHand: CardId[] = [];
	let gmPrivateProcedure: unknown;
	for (const [recipientUserId, fragment] of input.privateFragmentsByRecipient) {
		privateZones.push(...fragment.zones);
		if (recipientUserId === input.gmUserId) {
			gmHand = fragment.gmHand ?? [];
			gmPrivateProcedure = fragment.gmPrivateProcedure;
		}
	}

	const procedure = input.publicFragment.procedurePublic
		? {
				...input.publicFragment.procedurePublic,
				...(gmPrivateProcedure !== undefined ? { gmPrivate: gmPrivateProcedure } : {})
			}
		: null;

	return {
		schemaVersion: 1,
		sessionId: input.sessionId,
		version: input.version,
		phase: input.phase,
		procedure,
		majorDraw: input.serverFragment.majorDraw,
		majorDiscard: input.serverFragment.majorDiscard,
		playerDraw: input.serverFragment.playerDraw,
		playerDiscard: input.serverFragment.playerDiscard,
		gmHand,
		privateZones,
		publicZones: input.publicFragment.publicZones,
		pendingZones: input.serverFragment.pendingZones,
		reshuffleAtBoundary: input.serverFragment.reshuffleAtBoundary
	};
}

/** Inverse of `reassembleEngineState`: splits a full state back into the
 * three fragment shapes. `recipientUserIds` must be the fixed set already
 * loaded for this session (every original member + the GM) — no handler in
 * `$lib/engine/session/card-commands.ts` ever introduces a new zone owner,
 * so the recipient set never grows after session start. */
export function splitEngineState(
	state: SessionEngineStateV1,
	shuffleSeed: string,
	gmUserId: string,
	recipientUserIds: readonly string[]
): {
	publicFragment: SessionPublicFragmentV1;
	serverFragment: SessionServerFragmentV1;
	privateFragmentsByRecipient: Map<UserId, SessionPrivateFragmentV1>;
} {
	const publicFragment: SessionPublicFragmentV1 = {
		schemaVersion: 1,
		publicZones: state.publicZones,
		procedurePublic: state.procedure
			? { procedureId: state.procedure.procedureId, stepIndex: state.procedure.stepIndex, pendingZoneIds: state.procedure.pendingZoneIds }
			: null
	};

	const serverFragment: SessionServerFragmentV1 = {
		schemaVersion: 1,
		majorDraw: state.majorDraw,
		majorDiscard: state.majorDiscard,
		playerDraw: state.playerDraw,
		playerDiscard: state.playerDiscard,
		pendingZones: state.pendingZones,
		reshuffleAtBoundary: state.reshuffleAtBoundary,
		shuffleSeed
	};

	const privateFragmentsByRecipient = new Map<UserId, SessionPrivateFragmentV1>();
	for (const userId of recipientUserIds) {
		privateFragmentsByRecipient.set(userId, { schemaVersion: 1, zones: [] });
	}
	for (const zone of state.privateZones) {
		const fragment = privateFragmentsByRecipient.get(zone.ownerUserId) ?? { schemaVersion: 1, zones: [] };
		fragment.zones.push(zone);
		privateFragmentsByRecipient.set(zone.ownerUserId, fragment);
	}

	const gmFragment = privateFragmentsByRecipient.get(gmUserId) ?? { schemaVersion: 1, zones: [] };
	gmFragment.gmHand = state.gmHand;
	if (state.procedure?.gmPrivate !== undefined) gmFragment.gmPrivateProcedure = state.procedure.gmPrivate;
	privateFragmentsByRecipient.set(gmUserId, gmFragment);

	return { publicFragment, serverFragment, privateFragmentsByRecipient };
}

// ---------------------------------------------------------------------------
// Idempotency lookup
// ---------------------------------------------------------------------------

export interface StoredSessionCommandRow {
	id: string;
	requestHash: string;
	status: 'accepted' | 'rejected';
	resultingVersion: number | null;
	outcomeMetadataJson: string;
}

export async function findSessionCommand(db: AppDb, sessionId: string, commandId: string): Promise<StoredSessionCommandRow | null> {
	const row = await db
		.select({
			id: sessionCommands.id,
			requestHash: sessionCommands.requestHash,
			status: sessionCommands.status,
			resultingVersion: sessionCommands.resultingVersion,
			outcomeMetadataJson: sessionCommands.outcomeMetadataJson
		})
		.from(sessionCommands)
		.where(and(eq(sessionCommands.sessionId, sessionId), eq(sessionCommands.commandId, commandId)))
		.get();
	if (!row) return null;
	return { ...row, status: row.status as 'accepted' | 'rejected' };
}

/** The campaign's event cursor: the highest `campaignEvents.id` for
 * `campaignId`, or 0 if the campaign has no events yet. A SQL-level
 * aggregate — never pulls event rows into memory just to find their max. */
export async function campaignCursor(db: AppDb, campaignId: string): Promise<number> {
	const row = await db
		.select({ max: max(campaignEvents.id) })
		.from(campaignEvents)
		.where(eq(campaignEvents.campaignId, campaignId))
		.get();
	return row?.max ?? 0;
}

// ---------------------------------------------------------------------------
// Statement builders — every write in this module goes through these, never
// through Drizzle's query builder, so `command-service.ts`/`lifecycle.ts` can
// hand the results straight to `runAtomic`.
// ---------------------------------------------------------------------------

/** Inserts one `campaign_events` row and assigns its id via
 * `(SELECT COALESCE(MAX(id),0)+1 FROM campaign_events)` rather than leaving
 * the AUTOINCREMENT column to assign it implicitly. This is required, not
 * cosmetic: `campaign_event_secrets` rows in the *same* atomic batch need to
 * reference this row's id, and D1's `batch()` (unlike a real interactive
 * transaction) gives no way to read back an autoincrement id from an earlier
 * statement to bind into a later one. Both SQLite's `raw.transaction` and
 * D1's `raw.batch` run statements in order with each statement seeing
 * earlier same-batch writes, so this subquery — and the paired lookup in
 * `campaignEventSecretInsertStatement` below — resolve correctly on both
 * targets. Safe under concurrency because SQLite/D1 serialize writers: only
 * one write transaction is ever in flight, so no two transactions can
 * observe the same `MAX(id)` and both commit. */
function campaignEventInsertStatement(input: {
	campaignId: string;
	sessionId: string;
	commandRowId: string | null;
	actorUserId: string | null;
	kind: string;
	publicPayload: unknown;
	createdAt: Date;
}): AtomicStatement {
	return statement(
		`INSERT INTO campaign_events (id, campaign_id, session_id, command_id, actor_user_id, kind, public_payload_json, created_at)
		 VALUES ((SELECT COALESCE(MAX(id), 0) + 1 FROM campaign_events), ?, ?, ?, ?, ?, ?, ?)`,
		[
			input.campaignId,
			input.sessionId,
			input.commandRowId,
			input.actorUserId,
			input.kind,
			JSON.stringify(input.publicPayload),
			input.createdAt.getTime()
		]
	);
}

/** Like `campaignEventInsertStatement`, but expressed as `INSERT ... SELECT
 * ... WHERE EXISTS(...)` instead of `INSERT ... VALUES(...)`, so the row is
 * inserted only if `input.sessionId`'s `play_sessions` row still has status
 * `guardStatus` *after* the preceding statements in this same batch ran. Used
 * by the lifecycle
 * builders below so a status flip that turned out to be a no-op (belt-and-
 * suspenders alongside the version claim that should already prevent this)
 * never leaves behind an audit event claiming a transition happened when it
 * didn't. */
function conditionalCampaignEventInsertStatement(input: {
	campaignId: string;
	sessionId: string;
	commandRowId: string | null;
	actorUserId: string | null;
	kind: string;
	publicPayload: unknown;
	createdAt: Date;
	guardStatus: string;
}): AtomicStatement {
	return statement(
		`INSERT INTO campaign_events (id, campaign_id, session_id, command_id, actor_user_id, kind, public_payload_json, created_at)
		 SELECT (SELECT COALESCE(MAX(id), 0) + 1 FROM campaign_events), ?, ?, ?, ?, ?, ?, ?
		 WHERE EXISTS (SELECT 1 FROM play_sessions WHERE id = ? AND status = ?)`,
		[
			input.campaignId,
			input.sessionId,
			input.commandRowId,
			input.actorUserId,
			input.kind,
			JSON.stringify(input.publicPayload),
			input.createdAt.getTime(),
			input.sessionId,
			input.guardStatus
		]
	);
}

/** Inserts one `campaign_event_secrets` row for the `eventIndex`-th event
 * (0-based, insertion order) attached to `(sessionId, commandRowId)` in this
 * same batch — see `campaignEventInsertStatement`'s comment for why the
 * lookup is expressed this way rather than by a JS-held id. */
function campaignEventSecretInsertStatement(input: {
	id: string;
	sessionId: string;
	commandRowId: string;
	eventIndex: number;
	recipientUserId: string;
	payload: unknown;
	createdAt: Date;
}): AtomicStatement {
	return statement(
		`INSERT INTO campaign_event_secrets (id, event_id, recipient_user_id, payload_json, created_at)
		 VALUES (?, (SELECT id FROM campaign_events WHERE session_id = ? AND command_id = ? ORDER BY id ASC LIMIT 1 OFFSET ?), ?, ?, ?)`,
		[input.id, input.sessionId, input.commandRowId, input.eventIndex, input.recipientUserId, JSON.stringify(input.payload), input.createdAt.getTime()]
	);
}

function eventStatements(input: {
	campaignId: string;
	sessionId: string;
	commandRowId: string | null;
	actorUserId: string | null;
	events: readonly SessionEvent[];
	now: Date;
	idFactory: () => string;
}): AtomicStatement[] {
	const out: AtomicStatement[] = [];
	input.events.forEach((event, eventIndex) => {
		out.push(
			campaignEventInsertStatement({
				campaignId: input.campaignId,
				sessionId: input.sessionId,
				commandRowId: input.commandRowId,
				actorUserId: input.actorUserId,
				kind: event.kind,
				publicPayload: event.publicPayload,
				createdAt: input.now
			})
		);
		if (!event.privatePayloads || input.commandRowId === null) return;
		for (const [recipientUserId, payload] of Object.entries(event.privatePayloads)) {
			out.push(
				campaignEventSecretInsertStatement({
					id: input.idFactory(),
					sessionId: input.sessionId,
					commandRowId: input.commandRowId,
					eventIndex,
					recipientUserId,
					payload,
					createdAt: input.now
				})
			);
		}
	});
	return out;
}

/**
 * The `session_commands` version-claim insert, shared by every atomic write
 * that advances `play_sessions.version` by one: accepted `SessionCommand`s
 * AND lifecycle actions (freeze/recover/end — amendment 8's "structural
 * commands through the same service", now literal, not just patterned-
 * after). The unique partial index on `(session_id, resulting_version)`
 * (`db/schema.ts`) is what makes this the single point of serialization
 * between racing writers, regardless of whether they're two card commands or
 * a card command racing a GM's `endSession` — whichever one's claim lands
 * first wins; the loser's *entire* batch (fragment writes, cleanup deletes,
 * whatever it was) rolls back, never partially applies. This is the fix for
 * the critical race where lifecycle actions previously had no version claim
 * at all and could interleave with an in-flight command's commit. */
function sessionCommandClaimStatement(input: {
	commandRowId: string;
	sessionId: string;
	commandId: string;
	actorUserId: string | null;
	requestHash: string;
	commandType: string;
	clientObservedVersion: number;
	structuralPreconditionVersion: number | null;
	expectedVersion: number;
	now: Date;
}): AtomicStatement {
	return statement(
		`INSERT INTO session_commands
			(id, session_id, command_id, actor_user_id, request_hash, command_type,
			 client_observed_version, structural_precondition_version, expected_version, resulting_version,
			 status, outcome_metadata_json, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', '{}', ?)`,
		[
			input.commandRowId,
			input.sessionId,
			input.commandId,
			input.actorUserId,
			input.requestHash,
			input.commandType,
			input.clientObservedVersion,
			input.structuralPreconditionVersion,
			input.expectedVersion,
			input.expectedVersion + 1,
			input.now.getTime()
		]
	);
}

export interface AcceptedCommandInput {
	commandRowId: string;
	sessionId: string;
	campaignId: string;
	commandId: string;
	actorUserId: string;
	requestHash: string;
	/** A `SessionCommandType` for an in-band command, or a lifecycle action
	 * label (`'freeze-session'`/`'recover-session'`/`'end-session'`) — the
	 * `command_type` column is free text, no CHECK constraint. */
	commandType: string;
	clientObservedVersion: number;
	structuralPreconditionVersion: number | null;
	expectedVersion: number;
	nextState: SessionEngineStateV1;
	events: readonly SessionEvent[];
	shuffleSeed: string;
	gmUserId: string;
	recipientUserIds: readonly string[];
	now: Date;
	idFactory: () => string;
}

/** Builds the full atomic write for one accepted command: the version-claim
 * insert (whose `(sessionId, resultingVersion)` uniqueness is what turns a
 * racing writer into a constraint failure — see `db/schema.ts`), the public/
 * server/private fragment updates, and the resulting public/private events. */
export function buildAcceptedCommandStatements(input: AcceptedCommandInput): AtomicStatement[] {
	const nextVersion = input.expectedVersion + 1;
	const { publicFragment, serverFragment, privateFragmentsByRecipient } = splitEngineState(
		input.nextState,
		input.shuffleSeed,
		input.gmUserId,
		input.recipientUserIds
	);

	const statements: AtomicStatement[] = [
		sessionCommandClaimStatement({
			commandRowId: input.commandRowId,
			sessionId: input.sessionId,
			commandId: input.commandId,
			actorUserId: input.actorUserId,
			requestHash: input.requestHash,
			commandType: input.commandType,
			clientObservedVersion: input.clientObservedVersion,
			structuralPreconditionVersion: input.structuralPreconditionVersion,
			expectedVersion: input.expectedVersion,
			now: input.now
		}),
		statement(`UPDATE play_sessions SET version = ?, phase = ?, procedure_id = ?, public_state_json = ? WHERE id = ?`, [
			nextVersion,
			input.nextState.phase,
			input.nextState.procedure?.procedureId ?? null,
			JSON.stringify(publicFragment),
			input.sessionId
		]),
		statement(`UPDATE session_server_states SET session_version = ?, server_state_json = ?, updated_at = ? WHERE session_id = ?`, [
			nextVersion,
			JSON.stringify(serverFragment),
			input.now.getTime(),
			input.sessionId
		])
	];

	for (const [recipientUserId, fragment] of privateFragmentsByRecipient) {
		statements.push(
			statement(
				`UPDATE session_private_states SET session_version = ?, private_state_json = ?, updated_at = ? WHERE session_id = ? AND recipient_user_id = ?`,
				[nextVersion, JSON.stringify(fragment), input.now.getTime(), input.sessionId, recipientUserId]
			)
		);
	}

	statements.push(
		...eventStatements({
			campaignId: input.campaignId,
			sessionId: input.sessionId,
			commandRowId: input.commandRowId,
			actorUserId: input.actorUserId,
			events: input.events,
			now: input.now,
			idFactory: input.idFactory
		})
	);

	return statements;
}

export interface RejectedCommandInput {
	commandRowId: string;
	sessionId: string;
	commandId: string;
	actorUserId: string;
	requestHash: string;
	/** A `SessionCommandType` for an in-band command, or a lifecycle action
	 * label (`'freeze-session'`/`'recover-session'`/`'end-session'`) — the
	 * `command_type` column is free text, no CHECK constraint. */
	commandType: string;
	clientObservedVersion: number;
	structuralPreconditionVersion: number | null;
	expectedVersion: number;
	rejection: SessionRejection;
	now: Date;
}

/** A rejected command carries no version claim (`resulting_version` stays
 * NULL — the CHECK constraints in `db/schema.ts` require exactly this). The
 * rejection code/message are the only "outcome metadata" persisted, so a
 * later idempotent replay can return the identical rejection without ever
 * storing a private response body. */
export function buildRejectedCommandStatements(input: RejectedCommandInput): AtomicStatement[] {
	return [
		statement(
			`INSERT INTO session_commands
				(id, session_id, command_id, actor_user_id, request_hash, command_type,
				 client_observed_version, structural_precondition_version, expected_version, resulting_version,
				 status, outcome_metadata_json, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'rejected', ?, ?)`,
			[
				input.commandRowId,
				input.sessionId,
				input.commandId,
				input.actorUserId,
				input.requestHash,
				input.commandType,
				input.clientObservedVersion,
				input.structuralPreconditionVersion,
				input.expectedVersion,
				JSON.stringify({ code: input.rejection.code, message: input.rejection.message }),
				input.now.getTime()
			]
		)
	];
}

export interface FreezeSessionInput {
	commandRowId: string;
	commandId: string;
	sessionId: string;
	campaignId: string;
	/** `null` for the automatic freeze-on-error path (system-triggered, no
	 * specific acting user); a real user id for a future GM-initiated freeze. */
	actorUserId: string | null;
	/** The version this freeze claims to transition FROM — see
	 * `sessionCommandClaimStatement`'s doc comment for why this is what
	 * serializes freeze against a racing command/recover/end. */
	expectedVersion: number;
	reason: string;
	now: Date;
}

/** Freeze-on-error (brief Step 4's last paragraph): claims the next version
 * (exactly like an accepted structural command), flips status to `'frozen'`,
 * and records a redacted audit event — one atomic write. Claiming a version
 * here (rather than the pre-fix status-guarded-only approach) is what
 * prevents an in-flight command's commit — built from a read at the *same*
 * version — from landing after the freeze: both would try to claim the same
 * `resulting_version`, so only one can ever win. */
export function buildFreezeStatements(input: FreezeSessionInput): AtomicStatement[] {
	const requestHash = canonicalDigest({ action: 'freeze-session', reason: input.reason });
	return [
		sessionCommandClaimStatement({
			commandRowId: input.commandRowId,
			sessionId: input.sessionId,
			commandId: input.commandId,
			actorUserId: input.actorUserId,
			requestHash,
			commandType: 'freeze-session',
			clientObservedVersion: input.expectedVersion,
			structuralPreconditionVersion: input.expectedVersion,
			expectedVersion: input.expectedVersion,
			now: input.now
		}),
		statement(`UPDATE play_sessions SET version = ?, status = 'frozen' WHERE id = ? AND status != 'ended'`, [
			input.expectedVersion + 1,
			input.sessionId
		]),
		conditionalCampaignEventInsertStatement({
			campaignId: input.campaignId,
			sessionId: input.sessionId,
			commandRowId: input.commandRowId,
			actorUserId: input.actorUserId,
			kind: 'session-frozen',
			publicPayload: { reason: input.reason },
			createdAt: input.now,
			guardStatus: 'frozen'
		})
	];
}

export interface RecoverSessionInput {
	commandRowId: string;
	commandId: string;
	sessionId: string;
	campaignId: string;
	actorUserId: string;
	expectedVersion: number;
	now: Date;
}

/** Same version-claim pattern as `buildFreezeStatements` — see its doc
 * comment. */
export function buildRecoverStatements(input: RecoverSessionInput): AtomicStatement[] {
	const requestHash = canonicalDigest({ action: 'recover-session' });
	return [
		sessionCommandClaimStatement({
			commandRowId: input.commandRowId,
			sessionId: input.sessionId,
			commandId: input.commandId,
			actorUserId: input.actorUserId,
			requestHash,
			commandType: 'recover-session',
			clientObservedVersion: input.expectedVersion,
			structuralPreconditionVersion: input.expectedVersion,
			expectedVersion: input.expectedVersion,
			now: input.now
		}),
		statement(`UPDATE play_sessions SET version = ?, status = 'active' WHERE id = ? AND status = 'frozen'`, [
			input.expectedVersion + 1,
			input.sessionId
		]),
		conditionalCampaignEventInsertStatement({
			campaignId: input.campaignId,
			sessionId: input.sessionId,
			commandRowId: input.commandRowId,
			actorUserId: input.actorUserId,
			kind: 'session-recovered',
			publicPayload: {},
			createdAt: input.now,
			guardStatus: 'active'
		})
	];
}

export interface EndSessionInput {
	commandRowId: string;
	commandId: string;
	sessionId: string;
	campaignId: string;
	actorUserId: string;
	expectedVersion: number;
	finalPublicStateJson: string;
	publicHistoryChecksum: string;
	now: Date;
}

/**
 * End cleanup (amendment 9): claims the next version (same pattern as
 * `buildFreezeStatements` — the frozen envelope comment lists "end session"
 * as a structural intent, and this claim is what closes the critical race
 * where a racing accepted-command commit could otherwise land after this
 * batch's cleanup and resurrect deleted private/secret rows into an ended
 * session), stamps the final public snapshot + checksum, flips status to
 * `'ended'`, deletes every private-state row and secret payload for this
 * session, clears the server-only fragment's JSON (the shuffle seed and
 * hidden pile order never need to survive an ended session), and records the
 * closing event — all in the one atomic write. Because the whole batch lives
 * or dies with the claim, `finalPublicStateJson`/`publicHistoryChecksum`
 * (computed by the caller from a read at `expectedVersion`) can never commit
 * against a version other than the one they were actually computed from — if
 * a racing write claims `expectedVersion + 1` first, this whole batch
 * (checksum included) rolls back instead of silently persisting a stale
 * snapshot.
 */
export function buildEndSessionStatements(input: EndSessionInput): AtomicStatement[] {
	const requestHash = canonicalDigest({ action: 'end-session' });
	return [
		sessionCommandClaimStatement({
			commandRowId: input.commandRowId,
			sessionId: input.sessionId,
			commandId: input.commandId,
			actorUserId: input.actorUserId,
			requestHash,
			commandType: 'end-session',
			clientObservedVersion: input.expectedVersion,
			structuralPreconditionVersion: input.expectedVersion,
			expectedVersion: input.expectedVersion,
			now: input.now
		}),
		statement(
			`UPDATE play_sessions SET version = ?, status = 'ended', ended_at = ?, ended_by_user_id = ?, final_public_state_json = ?, public_history_checksum = ? WHERE id = ? AND status != 'ended'`,
			[input.expectedVersion + 1, input.now.getTime(), input.actorUserId, input.finalPublicStateJson, input.publicHistoryChecksum, input.sessionId]
		),
		statement(`UPDATE session_server_states SET server_state_json = '{}' WHERE session_id = ?`, [input.sessionId]),
		statement(`DELETE FROM session_private_states WHERE session_id = ?`, [input.sessionId]),
		statement(
			`DELETE FROM campaign_event_secrets WHERE event_id IN (SELECT id FROM campaign_events WHERE session_id = ?)`,
			[input.sessionId]
		),
		conditionalCampaignEventInsertStatement({
			campaignId: input.campaignId,
			sessionId: input.sessionId,
			commandRowId: input.commandRowId,
			actorUserId: input.actorUserId,
			kind: 'session-ended',
			publicPayload: { publicHistoryChecksum: input.publicHistoryChecksum },
			createdAt: input.now,
			guardStatus: 'ended'
		})
	];
}

export interface StartSessionInput {
	sessionId: string;
	campaignId: string;
	sequence: number;
	contentPackId: string;
	contentPackVersion: string;
	contentDigest: string;
	runtimeContent: SessionRuntimeContentV1;
	initialState: SessionEngineStateV1;
	shuffleSeed: string;
	gmUserId: string;
	memberUserIds: readonly string[];
	startedByUserId: string;
	now: Date;
	idFactory: () => string;
}

/**
 * Start (brief Step 5 / amendment 4): inserts `playSessions` with
 * `runtimeContentId` NULL, then `sessionRuntimeContents`, then updates
 * `playSessions.runtimeContentId` — the circular-FK insert order Task 3's
 * schema requires. Also seeds every well-known zone the frozen
 * `SessionCommand` vocabulary needs to be usable at all: one `hand:<userId>`/
 * `facedown:<userId>`/`prepared:<userId>` private zone per active member
 * (empty), and the four public zones (`initiative`/`played`/`revealed`/
 * `inspiration`, also empty) — no handler in `card-commands.ts` ever creates
 * a new zone entry, so without this seeding no move/draw/deal command could
 * ever have a valid destination.
 */
export function buildStartSessionStatements(input: StartSessionInput): AtomicStatement[] {
	const recipientUserIds = [...new Set([...input.memberUserIds, input.gmUserId])];
	const { publicFragment, serverFragment, privateFragmentsByRecipient } = splitEngineState(
		input.initialState,
		input.shuffleSeed,
		input.gmUserId,
		recipientUserIds
	);

	const statements: AtomicStatement[] = [
		statement(
			`INSERT INTO play_sessions
				(id, campaign_id, sequence, status, phase, content_pack_id, content_pack_version,
				 procedure_schema_version, content_digest, runtime_content_id, version,
				 public_state_schema_version, public_state_json, started_at, started_by_user_id)
			 VALUES (?, ?, ?, 'active', ?, ?, ?, 1, ?, NULL, 1, 1, ?, ?, ?)`,
			[
				input.sessionId,
				input.campaignId,
				input.sequence,
				input.initialState.phase,
				input.contentPackId,
				input.contentPackVersion,
				input.contentDigest,
				JSON.stringify(publicFragment),
				input.now.getTime(),
				input.startedByUserId
			]
		),
		statement(
			`INSERT INTO session_runtime_contents (session_id, schema_version, session_version, runtime_content_json, created_at)
			 VALUES (?, 1, 1, ?, ?)`,
			[input.sessionId, JSON.stringify(input.runtimeContent), input.now.getTime()]
		),
		statement(`UPDATE play_sessions SET runtime_content_id = ? WHERE id = ?`, [input.sessionId, input.sessionId]),
		statement(
			`INSERT INTO session_server_states (session_id, schema_version, session_version, server_state_json, updated_at)
			 VALUES (?, 1, 1, ?, ?)`,
			[input.sessionId, JSON.stringify(serverFragment), input.now.getTime()]
		)
	];

	for (const [recipientUserId, fragment] of privateFragmentsByRecipient) {
		statements.push(
			statement(
				`INSERT INTO session_private_states (id, session_id, recipient_user_id, schema_version, session_version, private_state_json, updated_at)
				 VALUES (?, ?, ?, 1, 1, ?, ?)`,
				[input.idFactory(), input.sessionId, recipientUserId, JSON.stringify(fragment), input.now.getTime()]
			)
		);
	}

	statements.push(
		campaignEventInsertStatement({
			campaignId: input.campaignId,
			sessionId: input.sessionId,
			commandRowId: null,
			actorUserId: input.startedByUserId,
			kind: 'session-started',
			publicPayload: { sequence: input.sequence },
			createdAt: input.now
		})
	);

	return statements;
}

/** Canonical zone ids seeded at session start (see `buildStartSessionStatements`). */
export function standardPublicZones(): PublicZone[] {
	return [
		{ id: 'initiative', kind: 'initiative', cards: [] },
		{ id: 'played', kind: 'played', cards: [] },
		{ id: 'revealed', kind: 'revealed', cards: [] },
		{ id: 'inspiration', kind: 'inspiration', cards: [] }
	];
}

export function standardPrivateZonesForMember(userId: string): OwnedPrivateZone[] {
	return [
		{ id: `hand:${userId}`, kind: 'player-hand', ownerUserId: userId, cards: [] },
		{ id: `facedown:${userId}`, kind: 'player-facedown', ownerUserId: userId, cards: [] },
		{ id: `prepared:${userId}`, kind: 'player-prepared', ownerUserId: userId, cards: [] }
	];
}
