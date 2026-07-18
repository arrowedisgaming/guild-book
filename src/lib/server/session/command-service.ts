/**
 * The command execution loop (Task 5 brief Step 4, overridden by controller
 * amendment 1's three-field envelope semantics). Authenticates nothing
 * itself — `actorUserId` is assumed already authenticated by the caller
 * (Task 6's HTTP layer) — but authorizes it against campaign membership,
 * strict-parses the envelope, enforces commandId+hash idempotency, loads and
 * reduces against a pinned-runtime engine state, and commits the result
 * atomically with a version claim. Never imports `@sveltejs/kit` — no HTTP
 * status codes in this layer.
 */

import { nanoid } from 'nanoid';
import type { AppDb } from '$lib/server/db';
import { runAtomic, isUniqueConstraintError, type AppDbContext } from '$lib/server/db/atomic';
import { sessionCommandEnvelopeSchema } from '$lib/schemas/session.schema';
import { sha256Hex, canonicalJsonStringify } from '$lib/server/content/canonical-json';
import { toSessionEngineRuntime } from '$lib/server/content/session-runtime';
import { reduceSession, type ReduceContext } from '$lib/engine/session/reducer';
import { projectForActor, type SessionProjection } from '$lib/engine/session/projection';
import { SessionInvariantError } from '$lib/engine/session/invariants';
import { makeRng } from '$lib/engine/rng';
import {
	buildAcceptedCommandStatements,
	buildRejectedCommandStatements,
	campaignCursor,
	findSessionCommand,
	loadSessionForReduce,
	loadSessionSummary,
	recordFreshCursorHintAfterCommit,
	resolveSessionActor,
	SessionLoadIntegrityError,
	SessionNotFoundError,
	type LoadedSession
} from './repository';
import { freezeSessionForFailure } from './lifecycle';
import type {
	CommandRejectionCode,
	SessionActor,
	SessionCommand,
	SessionCommandEnvelope,
	SessionCommandType,
	SessionEngineStateV1,
	SessionProjectionEnvelope,
	SessionRejection
} from '$lib/types/session';

/** Structural intents (spec §10.2 / the frozen envelope comment): the only
 * commands `expectedStructuralVersion` gates, and the only ones that hard-
 * reject (rather than retry) on a commit-time claim collision. */
const STRUCTURAL_COMMAND_TYPES: ReadonlySet<SessionCommandType> = new Set([
	'advance-procedure',
	'complete-procedure',
	'end-round',
	'apply-correction'
]);

const MAX_NONSTRUCTURAL_ATTEMPTS = 4;
const FROZEN_MESSAGE = 'session frozen due to an internal error; contact the GM';

export type CommandOutcome =
	| { ok: true; resultingVersion: number }
	| { ok: false; code: CommandRejectionCode; message: string };

export interface ExecuteCommandInput {
	dbContext: AppDbContext;
	campaignId: string;
	sessionId: string;
	/** Already authenticated by the caller; this service only authorizes it
	 * against campaign membership (amendment 11). */
	actorUserId: string;
	/** Not yet parsed/trusted — validated here against
	 * `sessionCommandEnvelopeSchema` before anything else touches it. */
	envelope: unknown;
}

export interface ExecuteCommandResult {
	outcome: CommandOutcome;
	/** The actor's current, freshly-loaded projection — present whenever the
	 * actor's role could be resolved and the session's fragments could still
	 * be loaded (e.g. absent once a session has ended and its private state
	 * has been deleted). Never a stored/replayed private response body. */
	projection: SessionProjectionEnvelope<SessionProjection> | null;
}

export async function executeCommand(input: ExecuteCommandInput): Promise<ExecuteCommandResult> {
	const { dbContext, campaignId, sessionId, actorUserId } = input;
	const db = dbContext.db as unknown as AppDb;

	// Step 1 (brief) — authorize. Authentication of `actorUserId` itself is
	// the caller's job (Task 6).
	const actor = await resolveSessionActor(db, campaignId, actorUserId);
	if (!actor) {
		return {
			outcome: { ok: false, code: 'not-authorized', message: 'actor is not a member of this campaign' },
			projection: null
		};
	}

	// Step 2 — strict-parse the envelope. A malformed envelope can't safely
	// yield an idempotency key, so it's never persisted.
	const parsed = sessionCommandEnvelopeSchema.safeParse(input.envelope);
	if (!parsed.success) {
		return {
			outcome: { ok: false, code: 'illegal-command', message: 'malformed command envelope' },
			projection: await loadProjectionForActor(db, sessionId, campaignId, actor)
		};
	}
	const envelope = parsed.data as unknown as SessionCommandEnvelope<SessionCommand>;
	// Hashes only `envelope.command` — deliberately excludes
	// `expectedStructuralVersion` (and `observedSessionVersion`/
	// `observedCharacterVersion`). This is a Task 6 client contract, not an
	// oversight: replaying the same `commandId` with the same `command` but a
	// *corrected* `expectedStructuralVersion` still hits the same hash, so the
	// idempotency lookup below replays the original stored outcome (including
	// a stale `stale-structure` rejection) rather than re-attempting with the
	// fixed precondition. A client that wants a genuine retry after
	// `stale-structure` must mint a new `commandId`.
	const requestHash = sha256Hex(canonicalJsonStringify(envelope.command));

	// Step 3 — idempotency lookup by (sessionId, commandId).
	const initialDuplicate = await resolveDuplicateCommandOutcome(db, sessionId, campaignId, envelope, requestHash, actor);
	if (initialDuplicate) return initialDuplicate;

	const isStructural = STRUCTURAL_COMMAND_TYPES.has(envelope.command.type);
	const maxAttempts = isStructural ? 1 : MAX_NONSTRUCTURAL_ATTEMPTS;

	let lastKnownVersion = envelope.observedSessionVersion;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		// A cheap status/version check first, via the lightweight summary — not
		// `loadSessionForReduce`. This matters for an *ended* session
		// specifically: end cleanup (amendment 9) deliberately deletes/clears
		// the private and server fragments, so a full fragment load against an
		// ended session correctly fails its own schema — but that's an
		// expected, benign consequence of ending, not a corruption to freeze
		// over. Checking status first keeps "session already ended" a normal
		// rejection instead of a false-positive freeze.
		const summary = await loadSessionSummary(db, sessionId);
		if (!summary || summary.campaignId !== campaignId) {
			return { outcome: { ok: false, code: 'illegal-command', message: 'session not found' }, projection: null };
		}
		lastKnownVersion = summary.version;

		if (summary.status !== 'active') {
			const rejection: SessionRejection = {
				code: 'illegal-command',
				message: `session is ${summary.status}, no commands are accepted`
			};
			return await persistRejectionOrReplayDuplicate(
				dbContext,
				db,
				campaignId,
				sessionId,
				envelope,
				actor,
				actorUserId,
				requestHash,
				summary.version,
				rejection
			);
		}

		if (isStructural && envelope.expectedStructuralVersion !== summary.version) {
			const rejection: SessionRejection = {
				code: 'stale-structure',
				message: `expected structural version ${envelope.expectedStructuralVersion ?? 'unset'} does not match current version ${summary.version}`
			};
			return await persistRejectionOrReplayDuplicate(
				dbContext,
				db,
				campaignId,
				sessionId,
				envelope,
				actor,
				actorUserId,
				requestHash,
				summary.version,
				rejection
			);
		}

		let loaded: LoadedSession;
		try {
			loaded = await loadSessionForReduce(db, sessionId);
		} catch (cause) {
			if (cause instanceof SessionLoadIntegrityError) {
				// `summary.version` (not `loaded.currentVersion` — the full load
				// just failed) is the freshest version this attempt actually
				// confirmed, so freeze claims against that.
				await freezeSessionForFailure(dbContext, { sessionId, campaignId, reason: 'load-integrity-failure', expectedVersion: summary.version });
				return { outcome: { ok: false, code: 'illegal-command', message: FROZEN_MESSAGE }, projection: null };
			}
			if (cause instanceof SessionNotFoundError) {
				return { outcome: { ok: false, code: 'illegal-command', message: 'session not found' }, projection: null };
			}
			throw cause;
		}
		lastKnownVersion = loaded.currentVersion;

		const rng = makeRng(deriveAttemptSeed(loaded.shuffleSeed, loaded.currentVersion, attempt));
		const context: ReduceContext = { actor, runtime: toSessionEngineRuntime(loaded.runtimeContent), rng };

		let reduceResult: ReturnType<typeof reduceSession>;
		try {
			reduceResult = reduceSession(loaded.engineState, envelope.command, context);
		} catch (cause) {
			if (cause instanceof SessionInvariantError) {
				await freezeSessionForFailure(dbContext, { sessionId, campaignId, reason: 'invariant-violation', expectedVersion: loaded.currentVersion });
				return { outcome: { ok: false, code: 'illegal-command', message: FROZEN_MESSAGE }, projection: null };
			}
			throw cause;
		}

		if (!reduceResult.ok) {
			return await persistRejectionOrReplayDuplicate(
				dbContext,
				db,
				campaignId,
				sessionId,
				envelope,
				actor,
				actorUserId,
				requestHash,
				loaded.currentVersion,
				reduceResult.rejection
			);
		}

		const nextState: SessionEngineStateV1 = { ...reduceResult.state, version: loaded.currentVersion + 1 };
		const statements = buildAcceptedCommandStatements({
			commandRowId: nanoid(),
			sessionId,
			campaignId,
			commandId: envelope.commandId,
			actorUserId,
			requestHash,
			commandType: envelope.command.type,
			clientObservedVersion: envelope.observedSessionVersion,
			structuralPreconditionVersion: envelope.expectedStructuralVersion ?? null,
			expectedVersion: loaded.currentVersion,
			nextState,
			events: reduceResult.events,
			shuffleSeed: loaded.shuffleSeed,
			gmUserId: loaded.gmUserId,
			recipientUserIds: loaded.recipientUserIds,
			now: new Date(),
			idFactory: () => nanoid()
		});

		try {
			await runAtomic(dbContext, statements);
			// Fix round 1: close the same-isolate false-204 window at the
			// source — see `recordFreshCursorHintAfterCommit`'s doc comment.
			await recordFreshCursorHintAfterCommit(db, campaignId);
			return {
				outcome: { ok: true, resultingVersion: loaded.currentVersion + 1 },
				projection: await loadProjectionForActor(db, sessionId, campaignId, actor)
			};
		} catch (cause) {
			if (!isUniqueConstraintError(cause)) throw cause;

			// This unique-constraint failure came from one of two indexes:
			// `session_commands_session_command_uq` (a genuine concurrent
			// duplicate of THIS commandId — a race, not a version claim loss) or
			// `session_commands_resulting_version_uq` (someone else's *different*
			// command claimed this version first). The two need different
			// handling, and the driver-agnostic way to tell them apart is to
			// re-run the same idempotency lookup Step 3 did: if a row for this
			// exact commandId now exists, the loser lost to its own duplicate and
			// must replay/reject via the normal duplicate path below, never via
			// the version-claim retry/stale-structure handling meant for a
			// different command.
			const duplicate = await resolveDuplicateCommandOutcome(db, sessionId, campaignId, envelope, requestHash, actor);
			if (duplicate) return duplicate;

			if (isStructural) {
				const rejection: SessionRejection = {
					code: 'stale-structure',
					message: 'the session advanced past the expected structural version'
				};
				return await persistRejectionOrReplayDuplicate(
					dbContext,
					db,
					campaignId,
					sessionId,
					envelope,
					actor,
					actorUserId,
					requestHash,
					loaded.currentVersion,
					rejection
				);
			}
			// Nonstructural: someone else claimed this version first. Loop back
			// to the top — reread state, re-reduce, try again (up to 4 total).
		}
	}

	const rejection: SessionRejection = {
		code: 'retry-exhausted',
		message: `command could not be committed after ${MAX_NONSTRUCTURAL_ATTEMPTS} attempts`
	};
	return await persistRejectionOrReplayDuplicate(
		dbContext,
		db,
		campaignId,
		sessionId,
		envelope,
		actor,
		actorUserId,
		requestHash,
		lastKnownVersion,
		rejection
	);
}

async function persistRejection(
	dbContext: AppDbContext,
	sessionId: string,
	envelope: SessionCommandEnvelope<SessionCommand>,
	actorUserId: string,
	requestHash: string,
	expectedVersion: number,
	rejection: SessionRejection
): Promise<void> {
	await runAtomic(
		dbContext,
		buildRejectedCommandStatements({
			commandRowId: nanoid(),
			sessionId,
			commandId: envelope.commandId,
			actorUserId,
			requestHash,
			commandType: envelope.command.type,
			clientObservedVersion: envelope.observedSessionVersion,
			structuralPreconditionVersion: envelope.expectedStructuralVersion ?? null,
			expectedVersion,
			rejection,
			now: new Date()
		})
	);
}

/** Step 3's idempotency lookup, factored out so it can also be re-run after a
 * `session_commands_session_command_uq` collision (a duplicate submission
 * that raced past the initial lookup — see the doc comments at both call
 * sites below). Returns `null` when no row exists yet for this commandId. */
async function resolveDuplicateCommandOutcome(
	db: AppDb,
	sessionId: string,
	campaignId: string,
	envelope: SessionCommandEnvelope<SessionCommand>,
	requestHash: string,
	actor: SessionActor
): Promise<ExecuteCommandResult | null> {
	const existing = await findSessionCommand(db, sessionId, envelope.commandId);
	if (!existing) return null;

	if (existing.requestHash !== requestHash) {
		return {
			outcome: { ok: false, code: 'command-id-reused', message: 'this commandId was already used for a different request' },
			projection: await loadProjectionForActor(db, sessionId, campaignId, actor)
		};
	}
	const outcome: CommandOutcome =
		existing.status === 'accepted'
			? { ok: true, resultingVersion: existing.resultingVersion as number }
			: { ok: false, ...(JSON.parse(existing.outcomeMetadataJson) as { code: CommandRejectionCode; message: string }) };
	return { outcome, projection: await loadProjectionForActor(db, sessionId, campaignId, actor) };
}

/**
 * Persists a rejection, but hardens against the same commandId-collision
 * race `resolveDuplicateCommandOutcome`'s callers guard on the accept path:
 * two concurrent requests carrying the same commandId can both reach a
 * rejection call site (e.g. both observe a non-active session, or both fail
 * the same structural precondition) with neither having persisted anything
 * yet, so the loser's own `INSERT` can hit
 * `session_commands_session_command_uq` here too. When that happens, this
 * re-checks by lookup (driver-agnostic, unlike message-sniffing) rather than
 * letting the unique-constraint error surface as a 500: if the winner's row
 * is now visible, follow the normal duplicate path (replay on a matching
 * hash, `command-id-reused` on a mismatched one) instead of the rejection
 * that was originally intended.
 */
async function persistRejectionOrReplayDuplicate(
	dbContext: AppDbContext,
	db: AppDb,
	campaignId: string,
	sessionId: string,
	envelope: SessionCommandEnvelope<SessionCommand>,
	actor: SessionActor,
	actorUserId: string,
	requestHash: string,
	expectedVersion: number,
	rejection: SessionRejection
): Promise<ExecuteCommandResult> {
	try {
		await persistRejection(dbContext, sessionId, envelope, actorUserId, requestHash, expectedVersion, rejection);
	} catch (cause) {
		if (isUniqueConstraintError(cause)) {
			const duplicate = await resolveDuplicateCommandOutcome(db, sessionId, campaignId, envelope, requestHash, actor);
			if (duplicate) return duplicate;
		}
		throw cause;
	}
	return {
		outcome: { ok: false, code: rejection.code, message: rejection.message },
		projection: await loadProjectionForActor(db, sessionId, campaignId, actor)
	};
}

/** `HMAC/hash of stored seed + sessionVersion + attempt` (amendment 10):
 * plain SHA-256 concatenation is enough decorrelation here — this derives an
 * RNG seed, not an authentication tag — so a retried nonstructural command
 * (after losing a claim race) shuffles differently than the attempt that
 * lost, instead of deterministically replaying the identical shuffle. */
function deriveAttemptSeed(shuffleSeedHex: string, sessionVersion: number, attempt: number): string {
	return sha256Hex(`${shuffleSeedHex}:${sessionVersion}:${attempt}`);
}

/**
 * Exported for Task 6's HTTP layer: GET reads (session detail, `/sync`) and
 * lifecycle PATCH responses need the identical actor-scoped, freshly-loaded
 * projection this module already builds after every command — one
 * implementation, so a route can never accidentally build (and thus
 * potentially leak) its own divergent projection.
 */
export async function loadProjectionForActor(
	db: AppDb,
	sessionId: string,
	campaignId: string,
	actor: SessionActor
): Promise<SessionProjectionEnvelope<SessionProjection> | null> {
	try {
		const loaded = await loadSessionForReduce(db, sessionId);
		const runtime = toSessionEngineRuntime(loaded.runtimeContent);
		const projection = projectForActor(loaded.engineState, actor, runtime.catalog);
		const cursor = await campaignCursor(db, campaignId);
		return { campaignCursor: cursor, sessionVersion: loaded.currentVersion, projection };
	} catch (cause) {
		if (!(cause instanceof SessionNotFoundError) && !(cause instanceof SessionLoadIntegrityError)) {
			console.error('[session] unexpected error building actor projection', cause);
		}
		return null;
	}
}
