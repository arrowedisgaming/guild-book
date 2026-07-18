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
	const requestHash = sha256Hex(canonicalJsonStringify(envelope.command));

	// Step 3 — idempotency lookup by (sessionId, commandId).
	const existing = await findSessionCommand(db, sessionId, envelope.commandId);
	if (existing) {
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
			await persistRejection(dbContext, sessionId, envelope, actorUserId, requestHash, summary.version, rejection);
			return {
				outcome: { ok: false, code: rejection.code, message: rejection.message },
				projection: await loadProjectionForActor(db, sessionId, campaignId, actor)
			};
		}

		if (isStructural && envelope.expectedStructuralVersion !== summary.version) {
			const rejection: SessionRejection = {
				code: 'stale-structure',
				message: `expected structural version ${envelope.expectedStructuralVersion ?? 'unset'} does not match current version ${summary.version}`
			};
			await persistRejection(dbContext, sessionId, envelope, actorUserId, requestHash, summary.version, rejection);
			return {
				outcome: { ok: false, code: rejection.code, message: rejection.message },
				projection: await loadProjectionForActor(db, sessionId, campaignId, actor)
			};
		}

		let loaded: LoadedSession;
		try {
			loaded = await loadSessionForReduce(db, sessionId);
		} catch (cause) {
			if (cause instanceof SessionLoadIntegrityError) {
				await freezeSessionForFailure(dbContext, { sessionId, campaignId, reason: 'load-integrity-failure' });
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
				await freezeSessionForFailure(dbContext, { sessionId, campaignId, reason: 'invariant-violation' });
				return { outcome: { ok: false, code: 'illegal-command', message: FROZEN_MESSAGE }, projection: null };
			}
			throw cause;
		}

		if (!reduceResult.ok) {
			await persistRejection(dbContext, sessionId, envelope, actorUserId, requestHash, loaded.currentVersion, reduceResult.rejection);
			return {
				outcome: { ok: false, code: reduceResult.rejection.code, message: reduceResult.rejection.message },
				projection: await loadProjectionForActor(db, sessionId, campaignId, actor)
			};
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
			return {
				outcome: { ok: true, resultingVersion: loaded.currentVersion + 1 },
				projection: await loadProjectionForActor(db, sessionId, campaignId, actor)
			};
		} catch (cause) {
			if (!isUniqueConstraintError(cause)) throw cause;

			if (isStructural) {
				const rejection: SessionRejection = {
					code: 'stale-structure',
					message: 'the session advanced past the expected structural version'
				};
				return {
					outcome: { ok: false, code: rejection.code, message: rejection.message },
					projection: await loadProjectionForActor(db, sessionId, campaignId, actor)
				};
			}
			// Nonstructural: someone else claimed this version first. Loop back
			// to the top — reread state, re-reduce, try again (up to 4 total).
		}
	}

	const rejection: SessionRejection = {
		code: 'retry-exhausted',
		message: `command could not be committed after ${MAX_NONSTRUCTURAL_ATTEMPTS} attempts`
	};
	await persistRejection(dbContext, sessionId, envelope, actorUserId, requestHash, lastKnownVersion, rejection);
	return {
		outcome: { ok: false, code: rejection.code, message: rejection.message },
		projection: await loadProjectionForActor(db, sessionId, campaignId, actor)
	};
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

/** `HMAC/hash of stored seed + sessionVersion + attempt` (amendment 10):
 * plain SHA-256 concatenation is enough decorrelation here — this derives an
 * RNG seed, not an authentication tag — so a retried nonstructural command
 * (after losing a claim race) shuffles differently than the attempt that
 * lost, instead of deterministically replaying the identical shuffle. */
function deriveAttemptSeed(shuffleSeedHex: string, sessionVersion: number, attempt: number): string {
	return sha256Hex(`${shuffleSeedHex}:${sessionVersion}:${attempt}`);
}

async function loadProjectionForActor(
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
