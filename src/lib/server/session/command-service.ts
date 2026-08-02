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
import { and, eq, exists, inArray, notExists } from 'drizzle-orm';
import type { AppDb } from '$lib/server/db';
import {
	runAtomic,
	isUniqueConstraintError,
	type AppDbContext,
	type AtomicStatement
} from '$lib/server/db/atomic';
import { recordCommandOutcome } from '$lib/server/observability/campaign-metrics';
import { runCampaignAtomic, type CampaignAtomicStatement } from '$lib/server/campaign/atomic';
import {
	campaignEvents,
	playSessions,
	sessionCommands,
	sessionPrivateStates,
	sessionServerStates
} from '$lib/server/db/schema';
import { migrateCharacterData } from '$lib/engine/character-migration';
import {
	buildResolveIntentStatements,
	readActorSpendingCharacterId,
	readResolveWriteContext,
	toAtomicStatements,
	type ResolveIntent,
	type ResolveWriteContext
} from '$lib/server/character/resource-write';
import {
	challengeDeathStatements,
	readChallengeDeathContext,
	type ChallengeDeathContext
} from '$lib/server/campaign/tenure';
import { ChallengeJoinSessionNotActiveError } from '$lib/server/campaign/session-state-port';
import type { SessionStatePort } from '$lib/server/campaign/session-state-port';
import { sessionCommandEnvelopeSchema } from '$lib/schemas/session.schema';
import { sha256Hex, canonicalJsonStringify } from '$lib/server/content/canonical-json';
import { toSessionEngineRuntime } from '$lib/server/content/session-runtime';
import { reduceSession, type ReduceContext } from '$lib/engine/session/reducer';
import { projectForActor, type SessionProjection } from '$lib/engine/session/projection';
import { SessionInvariantError } from '$lib/engine/session/invariants';
import { makeRng } from '$lib/engine/rng';
import {
	admitPendingJoinTenure,
	markTenureDead,
	type ChallengeReduceContext
} from '$lib/engine/session/procedures/challenge/reducer';
import { buildChallengeConfig } from '$lib/engine/session/procedures/challenge/schema';
import {
	buildAcceptedCommandStatements,
	buildRejectedCommandStatements,
	campaignCursor,
	findOpenSessionForCampaign,
	findSessionCommand,
	loadSessionForReduce,
	loadSessionSummary,
	recordFreshCursorHintAfterCommit,
	resolveSessionActor,
	splitEngineState,
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
	SessionRejection,
	SessionRuntimeContentV1
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

/**
 * Increment 5 Task 2: what the instrumented wrapper below is allowed to know.
 * Every field is a coarse label or a count — no ids, no envelope, no payload.
 * Threaded rather than returned so the many early-return paths inside
 * `executeCommandInstrumented` do not each have to carry it.
 */
interface CommandTelemetry {
	attempts: number;
	commandType?: string;
	procedureKind?: string;
	actorRole?: 'gm' | 'player';
	duplicate?: boolean;
}

export async function executeCommand(input: ExecuteCommandInput): Promise<ExecuteCommandResult> {
	const startedAt = Date.now();
	const telemetry: CommandTelemetry = { attempts: 1 };

	try {
		const result = await executeCommandInstrumented(input, telemetry);
		recordCommandOutcome({
			durationMs: Date.now() - startedAt,
			attempts: telemetry.attempts,
			commandType: telemetry.commandType,
			procedureKind: telemetry.procedureKind,
			actorRole: telemetry.actorRole,
			outcome: result.outcome.ok
				? telemetry.duplicate
					? 'duplicate'
					: 'accepted'
				: result.outcome.code
		});
		return result;
	} catch (cause) {
		// An unexpected throw is still an operational signal; `internal-error`
		// is not on the outcome allowlist, so it is recorded as `other`.
		recordCommandOutcome({
			durationMs: Date.now() - startedAt,
			attempts: telemetry.attempts,
			commandType: telemetry.commandType,
			procedureKind: telemetry.procedureKind,
			actorRole: telemetry.actorRole,
			outcome: 'internal-error'
		});
		throw cause;
	}
}

async function executeCommandInstrumented(
	input: ExecuteCommandInput,
	telemetry: CommandTelemetry
): Promise<ExecuteCommandResult> {
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
	telemetry.actorRole = actor.kind;

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
	telemetry.commandType = envelope.command.type;
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
	if (initialDuplicate) {
		telemetry.duplicate = true;
		return initialDuplicate;
	}

	const isStructural = STRUCTURAL_COMMAND_TYPES.has(envelope.command.type);
	const maxAttempts = isStructural ? 1 : MAX_NONSTRUCTURAL_ATTEMPTS;

	// Increment 4 Task 1 Step 3: a command carrying the reconfirmation pair is
	// a Resolve purchase. Only `advance-procedure` can be one — favor is bought
	// by advancing a procedure past its purchase step (Task 2 narrows this
	// further, to the specific step that offers it). Any other command type
	// carrying the pair is a client bug or an attempt to spend outside a
	// procedure, and is refused before anything is read, drawn, or persisted.
	const spendsResolve = envelope.expectedResolveCurrent !== undefined;
	if (spendsResolve && envelope.command.type !== 'advance-procedure') {
		return {
			outcome: { ok: false, code: 'illegal-command', message: 'only a procedure step may spend Resolve' },
			projection: await loadProjectionForActor(db, sessionId, campaignId, actor)
		};
	}

	let lastKnownVersion = envelope.observedSessionVersion;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		telemetry.attempts = attempt;
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
		// Coarse phase only — never the specific procedure the table is running.
		telemetry.procedureKind = loaded.engineState.phase;

		// Issue #14: the guard above validated the precondition against
		// `summary.version`, but the claim below is built from
		// `loaded.currentVersion` — a different, later read. On D1 the gap
		// between the two is a real network round trip, and a rival committing
		// inside it advanced the version so the claim targeted a *free*
		// resulting version and `session_commands_resulting_version_uq` never
		// fired: the command applied to a version its actor declared it was not
		// expecting. Re-validating against the read that feeds the claim (the
		// same pattern `procedure-command-loop.ts` uses) closes the window, not
		// merely narrows it: after this check the declared precondition and the
		// claim base are the same number, so a rival committing in the
		// remaining window must claim the same resulting version and collide on
		// the unique index, taking the `stale-structure` path in the catch
		// below. The summary-level guard stays as the cheap fast path that
		// spares the full fragment load for the common sequential-stale case.
		if (isStructural && envelope.expectedStructuralVersion !== loaded.currentVersion) {
			const rejection: SessionRejection = {
				code: 'stale-structure',
				message: `expected structural version ${envelope.expectedStructuralVersion ?? 'unset'} does not match current version ${loaded.currentVersion}`
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

		// The purchase is evaluated BEFORE the reduce, so a refused spend never
		// draws a card (Step 3: "no command row/version is accepted"). Re-read
		// on every attempt — a retry that lost a session version race may also
		// have lost a character version race.
		let resolveSpend: ResolveSpend | null = null;
		if (spendsResolve) {
			const evaluated = await evaluateResolveSpend(db, campaignId, sessionId, actorUserId, resolveSpendRequest(envelope));
			if (!evaluated.ok) {
				// Deliberately NOT persisted as a rejection row. The client's whole
				// job on `resource-changed` is to show the current numbers and ask
				// again, and a persisted rejection under this commandId would make
				// the reconfirmed retry replay the stale refusal (see
				// `resolveDuplicateCommandOutcome`). Nothing was written, so there
				// is nothing to audit.
				return {
					outcome: evaluated.outcome,
					projection: await loadProjectionForActor(db, sessionId, campaignId, actor)
				};
			}
			resolveSpend = evaluated.spend;
		}

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
		const statements: AtomicStatement[] = buildAcceptedCommandStatements({
			commandRowId: nanoid(),
			sessionId,
			campaignId,
			commandId: envelope.commandId,
			actorUserId,
			requestHash,
			commandType: envelope.command.type,
			clientObservedVersion: envelope.observedSessionVersion,
			// Only a STRUCTURAL command's declared version is a structural
			// precondition. The envelope field is schema-valid on every command,
			// so a non-structural one may carry a stale value the guard above
			// deliberately does not police — recording it here would both
			// mislabel the audit row and trip the claim builder's invariant,
			// which throws outside the commit's `catch` and would escape as a
			// 500 instead of a command outcome.
			structuralPreconditionVersion: isStructural ? (envelope.expectedStructuralVersion ?? null) : null,
			expectedVersion: loaded.currentVersion,
			nextState,
			events: reduceResult.events,
			shuffleSeed: loaded.shuffleSeed,
			gmUserId: loaded.gmUserId,
			recipientUserIds: loaded.recipientUserIds,
			now: new Date(),
			idFactory: () => nanoid()
		});

		if (resolveSpend) {
			// ONE atomic unit: the command claim, the session fragments, the
			// events, AND the character's narrow Resolve write. A spend that
			// commits without its draw (or a draw that commits without its
			// spend) is exactly the partial-purchase failure Step 2 forbids.
			statements.push(
				...toAtomicStatements(buildResolveIntentStatements(db, resolveSpend.intent, resolveSpend.context))
			);
		}

		try {
			await runAtomic(dbContext, statements);
			// Fix round 1: close the same-isolate false-204 window at the
			// source — see `recordFreshCursorHintAfterCommit`'s doc comment.
			const committedCursor = await recordFreshCursorHintAfterCommit(db, campaignId);
			return {
				outcome: { ok: true, resultingVersion: loaded.currentVersion + 1 },
				// Projected from the state this request just committed, rather than
				// re-read from the database (2026-07-28 round-trip reduction). The
				// reload cost five round trips — after batching, two — plus a second
				// read of the cursor the line above already fetched, purely to
				// reconstruct something already in memory.
				//
				// This is not merely cheaper, it is tighter: a reload can observe a
				// LATER command that committed in between, returning a projection
				// whose version runs ahead of the `resultingVersion` reported beside
				// it. `nextState` is by construction exactly what was written for
				// this command, so the two always agree.
				//
				// `session-command-service.test.ts` pins the equivalence against an
				// authoritative reload; if the fragment round trip is ever made lossy
				// that test fails rather than this silently drifting.
				//
				// Review round 2: there is deliberately NO fallback read here when
				// `committedCursor` is null. Nothing after a successful `runAtomic`
				// may throw, because the `catch` below is written entirely for a
				// FAILED commit — a throw here would re-evaluate the Resolve spend
				// against state this command has already decremented and could report
				// "insufficient Resolve" for a command that committed, or rethrow as
				// a 500 for the same. A fallback would also just retry the very query
				// whose failure produced the null.
				//
				// A null cursor therefore yields a null projection, which is exactly
				// what `loadProjectionForActor` returns when it cannot build one. The
				// commit stands, the outcome is still `ok`, and the client picks the
				// change up on its next poll ~1s later.
				projection:
					committedCursor === null
						? null
						: projectCommittedState({
								state: nextState,
								runtimeContent: loaded.runtimeContent,
								actor,
								campaignCursor: committedCursor
							})
			};
		} catch (cause) {
			// A lost Resolve claim fails the batch through its FK receipt, not a
			// unique index, so it would otherwise fall through to the `throw`
			// below as a 500. Re-evaluate first: if Resolve genuinely moved
			// between this attempt's read and its commit, that is the ordinary
			// reconfirmation path, not an internal error.
			if (resolveSpend) {
				const reEvaluated = await evaluateResolveSpend(db, campaignId, sessionId, actorUserId, resolveSpendRequest(envelope));
				if (!reEvaluated.ok) {
					return {
						outcome: reEvaluated.outcome,
						projection: await loadProjectionForActor(db, sessionId, campaignId, actor)
					};
				}
			}
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

export interface ResolveSpend {
	intent: ResolveIntent;
	context: ResolveWriteContext;
}

/** The three envelope fields a spend evaluation actually reads. Named
 * separately (Increment 4 Task 2) so `guided-test-command-service.ts` can reuse
 * `evaluateResolveSpend` verbatim: its envelope carries the same reconfirmation
 * pair but a different command union, and duplicating this security-sensitive
 * path so the two could drift is exactly the wrong trade. */
export interface ResolveSpendRequest {
	observedCharacterVersion: number;
	expectedResolveCurrent: number;
	/** Audit label for the version claim — the command type that bought favor. */
	commandType: string;
}

/**
 * Increment 4 Task 1: turns the envelope's reconfirmation pair into a validated
 * spend, or into the outcome the client should act on. Never mutates.
 *
 * The refusal codes deliberately reuse the existing rejection vocabulary rather
 * than inventing session-level ones — `content-mismatch` is the frozen code for
 * "your precondition no longer matches the server's facts," which is exactly
 * what a moved Resolve value is. The numeric current values ride in `message`,
 * where the UI already surfaces rejection text; no character document is ever
 * returned (Step 3).
 */
/** Narrows the generic envelope to the three fields a spend evaluation reads.
 * Both fields are non-`undefined` by the time this is called — the caller has
 * already checked `expectedResolveCurrent !== undefined`, and
 * `sessionCommandEnvelopeSchema` requires the pair together. */
function resolveSpendRequest(envelope: SessionCommandEnvelope<SessionCommand>): ResolveSpendRequest {
	return {
		observedCharacterVersion: envelope.observedCharacterVersion as number,
		expectedResolveCurrent: envelope.expectedResolveCurrent as number,
		commandType: envelope.command.type
	};
}

export async function evaluateResolveSpend(
	db: AppDb,
	campaignId: string,
	sessionId: string,
	actorUserId: string,
	request: ResolveSpendRequest
): Promise<{ ok: true; spend: ResolveSpend } | { ok: false; outcome: CommandOutcome }> {
	const characterId = await readActorSpendingCharacterId(db, campaignId, actorUserId);
	if (!characterId) {
		return {
			ok: false,
			outcome: { ok: false, code: 'illegal-command', message: 'no living adventurer at this table can spend Resolve' }
		};
	}

	const intent: ResolveIntent = {
		campaignId,
		sessionId,
		characterId,
		actorUserId,
		expectedCharacterVersion: request.observedCharacterVersion,
		expectedResolveCurrent: request.expectedResolveCurrent,
		delta: -1,
		reason: request.commandType,
		now: new Date()
	};

	const read = await readResolveWriteContext(db, intent);
	if (read.ok) return { ok: true, spend: { intent, context: read.context } };

	switch (read.reason) {
		case 'resource-changed':
			return {
				ok: false,
				outcome: {
					ok: false,
					code: 'content-mismatch',
					message: `Resolve is now ${read.currentResolve} (version ${read.currentVersion}); confirm the spend again`
				}
			};
		case 'insufficient-resolve':
			return {
				ok: false,
				outcome: { ok: false, code: 'illegal-command', message: `not enough Resolve (${read.currentResolve} remaining)` }
			};
		case 'not-authorized':
			return { ok: false, outcome: { ok: false, code: 'not-authorized', message: 'that adventurer is not yours' } };
		default:
			return { ok: false, outcome: { ok: false, code: 'illegal-command', message: 'that adventurer cannot spend Resolve' } };
	}
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
/**
 * Builds an actor projection from state this request has ALREADY committed,
 * with no database read at all.
 *
 * Only ever call this with the exact state that was just persisted — never with
 * a pre-commit state, and never on a path that did not commit. Every other
 * caller must use `loadProjectionForActor`, which reads authoritatively.
 *
 * The pinned runtime content is safe to carry over: it is immutable once a
 * session starts (`loadSessionForReduce` digest-verifies it rather than
 * re-deriving it), so the copy loaded before the commit is the same one a
 * reload would return.
 */
function projectCommittedState(input: {
	state: SessionEngineStateV1;
	runtimeContent: SessionRuntimeContentV1;
	actor: SessionActor;
	campaignCursor: number;
}): SessionProjectionEnvelope<SessionProjection> | null {
	try {
		const runtime = toSessionEngineRuntime(input.runtimeContent);
		return {
			campaignCursor: input.campaignCursor,
			sessionVersion: input.state.version,
			projection: projectForActor(input.state, input.actor, runtime.catalog)
		};
	} catch (cause) {
		// Matches `loadProjectionForActor`'s contract: a projection that cannot be
		// built is `null`, never an error that would mask a successful commit.
		console.error('[session] unexpected error projecting committed state', cause);
		return null;
	}
}

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

// ---------------------------------------------------------------------------
// Challenge death (Increment 3 Task 5, O4)
//
// A DIFFERENT atomic-write path from `executeCommand` above, by design: an
// accepted `SessionCommand` only ever touches session-engine tables, so
// `buildAcceptedCommandStatements` + `runAtomic` (raw statements) is the
// right tool. Marking a participating adventurer dead ALSO has to claim the
// character version, update its life JSON/status, end its tenure, and free
// membership eligibility — campaign/character tables `$lib/server/campaign/
// tenure.ts` already writes via Drizzle + `runCampaignAtomic` (Increment 1's
// established conditional-claim pattern). Rather than bridge two different
// low-level execution engines for one write, this path expresses the
// session-fragment side ALSO as plain Drizzle statements (mirroring
// `buildAcceptedCommandStatements`'s content, just not its raw-SQL idiom) so
// everything — character claim, character update, tenure end, session
// fragments, and the redaction/death events — runs through ONE
// `runCampaignAtomic` call. `$lib/server/character/life.ts`'s
// `markCharacterDead` is untouched: it remains the out-of-session/no-active-
// procedure death path.
// ---------------------------------------------------------------------------

/**
 * Review Critical 1 / Important 2: EVERY version-advancing write to
 * `play_sessions` must participate in the SAME serialization index every
 * other one does — `repository.ts`'s `sessionCommandClaimStatement` doc
 * comment: the unique partial index on `(session_id, resulting_version)` in
 * `session_commands` "is what makes this the single point of serialization
 * between racing writers." Both `buildChallengeDeathStatements` and
 * `buildPendingChallengeJoinStatements` bypass `buildAcceptedCommandStatements`
 * (they run through `runCampaignAtomic`, not `runAtomic` — see the file
 * header above), so neither one is automatically covered by that claim
 * unless it inserts an equivalent row itself. Before this fix, NEITHER did:
 * an ordinary `SessionCommand` racing a Challenge death (or a pending-join
 * registration) could silently overwrite it, or be silently overwritten by
 * it, with both writers reporting success — exactly the partial-death/lost-
 * update failure mode O4 forbids. This is the Drizzle-statement equivalent of
 * `sessionCommandClaimStatement`, inserting the identical row shape so it
 * competes for the identical unique index.
 */
/** Exported (Increment 4 Task 6) so `member-cleanup.ts` claims versions
 * through the same serialization index as every other version-advancing
 * write. */
export function sessionVersionClaimStatement(
	db: AppDb,
	input: { sessionId: string; actorUserId: string | null; commandType: string; expectedVersion: number; now: Date }
): CampaignAtomicStatement {
	const commandRowId = nanoid();
	const requestHash = sha256Hex(
		canonicalJsonStringify({ action: input.commandType, sessionId: input.sessionId, expectedVersion: input.expectedVersion, commandRowId })
	);
	return db.insert(sessionCommands).values({
		id: commandRowId,
		sessionId: input.sessionId,
		commandId: commandRowId,
		actorUserId: input.actorUserId,
		requestHash,
		commandType: input.commandType,
		clientObservedVersion: input.expectedVersion,
		structuralPreconditionVersion: input.expectedVersion,
		expectedVersion: input.expectedVersion,
		resultingVersion: input.expectedVersion + 1,
		status: 'accepted',
		outcomeMetadataJson: '{}',
		createdAt: input.now
	});
}

export interface ChallengeDeathInput {
	db: AppDb;
	campaignId: string;
	sessionId: string;
	/** The dying tenure — a `campaignAdventurerTenures.id`, never a user id
	 * (O1/O7). */
	tenureId: string;
	actorUserId: string;
	now?: Date;
}

export type ChallengeDeathFailureReason =
	| 'not-found'
	| 'not-authorized'
	| 'illegal-command'
	| 'version-conflict'
	| 'conflict';

export type ChallengeDeathOutcome =
	| { ok: true; sessionVersion: number; characterVersion: number; endedTenureId: string }
	| { ok: false; reason: ChallengeDeathFailureReason; message?: string };

type BuildChallengeDeathStatementsResult =
	| {
			ok: true;
			statements: CampaignAtomicStatement[];
			expectedSessionVersion: number;
			expectedCharacterVersion: number;
			nextSessionVersion: number;
			nextCharacterVersion: number;
	  }
	| { ok: false; reason: ChallengeDeathFailureReason; message?: string };

/**
 * Builds (but does NOT run) the full atomic statement list for a Challenge
 * death, WITHOUT mutating anything — separated from `executeChallengeDeath`
 * so a caller (this module's own tests, `tests/integration/
 * challenge-death.test.ts`) can inject a failure at any one statement and
 * prove the whole batch rolls back, exactly like `session-atomicity.test.ts`
 * already does for `buildAcceptedCommandStatements`.
 *
 * Validates and rejects (never throws on caller input — O5) at every step:
 * actor resolution, session load/status, tenure/character eligibility, and
 * the pure `markTenureDead` reducer's own authorization/stage checks are ALL
 * evaluated before a single statement is built.
 */
export async function buildChallengeDeathStatements(
	input: ChallengeDeathInput
): Promise<BuildChallengeDeathStatementsResult> {
	const { db } = input;
	const now = input.now ?? new Date();

	const actor = await resolveSessionActor(db, input.campaignId, input.actorUserId);
	if (!actor) return { ok: false, reason: 'not-authorized' };

	let loaded: LoadedSession;
	try {
		loaded = await loadSessionForReduce(db, input.sessionId);
	} catch (cause) {
		if (cause instanceof SessionNotFoundError || cause instanceof SessionLoadIntegrityError) {
			return { ok: false, reason: 'not-found' };
		}
		throw cause;
	}
	if (loaded.campaignId !== input.campaignId) return { ok: false, reason: 'not-found' };
	if (loaded.status !== 'active') {
		return { ok: false, reason: 'illegal-command', message: `session is ${loaded.status}, no commands are accepted` };
	}

	const deathContext = await readChallengeDeathContext(db, input.tenureId);
	if (!deathContext || deathContext.campaignId !== input.campaignId) {
		return { ok: false, reason: 'not-found' };
	}

	const config = buildChallengeConfig(loaded.runtimeContent.procedures, loaded.runtimeContent.formulas);
	const rng = makeRng(deriveAttemptSeed(loaded.shuffleSeed, loaded.currentVersion, 1));
	const context: ChallengeReduceContext = { actor, runtime: toSessionEngineRuntime(loaded.runtimeContent), rng, config };

	const reduceResult = markTenureDead(loaded.engineState, input.tenureId, context);
	if (!reduceResult.ok) {
		return {
			ok: false,
			reason: reduceResult.rejection.code === 'not-authorized' ? 'not-authorized' : 'illegal-command',
			message: reduceResult.rejection.message
		};
	}

	const nextSessionVersion = loaded.currentVersion + 1;
	const nextCharacterVersion = deathContext.characterVersion + 1;
	const finalState: SessionEngineStateV1 = { ...reduceResult.state, version: nextSessionVersion };
	const { publicFragment, serverFragment, privateFragmentsByRecipient } = splitEngineState(
		finalState,
		loaded.shuffleSeed,
		loaded.gmUserId,
		loaded.recipientUserIds
	);

	const claimId = nanoid();
	const sessionGuard = exists(
		db
			.select({ id: playSessions.id })
			.from(playSessions)
			.where(and(eq(playSessions.id, input.sessionId), eq(playSessions.version, loaded.currentVersion)))
	);

	const statements: CampaignAtomicStatement[] = [
		// Review Critical 1: claims `nextSessionVersion` in the SAME
		// `session_commands` serialization index every other version-advancing
		// write uses — see `sessionVersionClaimStatement`'s doc comment.
		sessionVersionClaimStatement(db, {
			sessionId: input.sessionId,
			actorUserId: input.actorUserId,
			commandType: 'challenge-death',
			expectedVersion: loaded.currentVersion,
			now
		}),
		...challengeDeathStatements(db, {
			claimId,
			campaignId: input.campaignId,
			characterId: deathContext.characterId,
			tenureId: input.tenureId,
			actorUserId: input.actorUserId,
			sessionId: input.sessionId,
			characterDataJson: buildDeadCharacterDataJson(
				deathContext,
				input.campaignId,
				input.sessionId,
				input.actorUserId,
				now
			),
			expectedCharacterVersion: deathContext.characterVersion,
			now,
			sessionGuard
		}),
		db
			.update(playSessions)
			.set({
				version: nextSessionVersion,
				phase: finalState.phase,
				procedureId: finalState.procedure?.procedureId ?? null,
				publicStateJson: JSON.stringify(publicFragment)
			})
			.where(and(eq(playSessions.id, input.sessionId), eq(playSessions.version, loaded.currentVersion))),
		db
			.update(sessionServerStates)
			.set({ sessionVersion: nextSessionVersion, serverStateJson: JSON.stringify(serverFragment), updatedAt: now })
			.where(and(eq(sessionServerStates.sessionId, input.sessionId), eq(sessionServerStates.sessionVersion, loaded.currentVersion)))
	];

	for (const [recipientUserId, fragment] of privateFragmentsByRecipient) {
		statements.push(
			db
				.update(sessionPrivateStates)
				.set({ sessionVersion: nextSessionVersion, privateStateJson: JSON.stringify(fragment), updatedAt: now })
				.where(
					and(
						eq(sessionPrivateStates.sessionId, input.sessionId),
						eq(sessionPrivateStates.recipientUserId, recipientUserId),
						eq(sessionPrivateStates.sessionVersion, loaded.currentVersion)
					)
				)
		);
	}

	for (const event of reduceResult.events) {
		if (event.privatePayloads) {
			// Never reachable today (every card leaving a hand during death
			// lands in a PUBLIC discard pile — `card-commands.ts`'s
			// `buildMoveEvent` only attaches `privatePayloads` for a private
			// destination), but guarded rather than silently dropped: this path
			// has no `campaign_event_secrets` writer, and dropping a private
			// payload silently would be worse than failing loudly.
			throw new Error(`buildChallengeDeathStatements: unexpected private payload on event ${event.kind}`);
		}
		statements.push(
			db.insert(campaignEvents).values({
				campaignId: input.campaignId,
				membershipId: deathContext.membershipId,
				tenureId: input.tenureId,
				characterId: deathContext.characterId,
				sessionId: input.sessionId,
				actorUserId: input.actorUserId,
				kind: event.kind,
				publicPayloadJson: JSON.stringify(event.publicPayload),
				createdAt: now
			})
		);
	}

	statements.push(
		db.insert(campaignEvents).values({
			campaignId: input.campaignId,
			membershipId: deathContext.membershipId,
			tenureId: input.tenureId,
			characterId: deathContext.characterId,
			sessionId: input.sessionId,
			actorUserId: input.actorUserId,
			kind: 'adventurer.died',
			publicPayloadJson: JSON.stringify({
				membershipId: deathContext.membershipId,
				characterId: deathContext.characterId,
				sessionId: input.sessionId
			}),
			createdAt: now
		})
	);

	return {
		ok: true,
		statements,
		expectedSessionVersion: loaded.currentVersion,
		expectedCharacterVersion: deathContext.characterVersion,
		nextSessionVersion,
		nextCharacterVersion
	};
}

function buildDeadCharacterDataJson(
	context: ChallengeDeathContext,
	campaignId: string,
	sessionId: string,
	actorUserId: string,
	now: Date
): string {
	let migrated;
	try {
		migrated = migrateCharacterData(JSON.parse(context.characterDataJson));
	} catch {
		migrated = migrateCharacterData(null);
	}
	migrated.life = {
		status: 'dead',
		diedAt: now.toISOString(),
		campaignId,
		sessionId,
		markedByUserId: actorUserId
	};
	return JSON.stringify(migrated);
}

/** Re-reads current character/tenure/session state after a failed commit to
 * classify WHY (never surfaced to the caller as a bare crash unless it truly
 * is unexplained) — mirrors `$lib/server/character/life.ts`'s
 * `classifyDeathWriteFailure`. Returns `null` (meaning: rethrow, this is a
 * genuinely unexpected failure) when none of the known causes explain it. */
async function classifyChallengeDeathFailure(
	input: ChallengeDeathInput,
	expected: { characterVersion: number; sessionVersion: number }
): Promise<ChallengeDeathOutcome | null> {
	const context = await readChallengeDeathContext(input.db, input.tenureId);
	if (!context) return { ok: false, reason: 'conflict', message: 'the tenure or character changed before this death could commit' };
	if (context.characterVersion !== expected.characterVersion) {
		return { ok: false, reason: 'version-conflict', message: `character is now at version ${context.characterVersion}` };
	}
	try {
		const reloaded = await loadSessionForReduce(input.db, input.sessionId);
		if (reloaded.currentVersion !== expected.sessionVersion) {
			return { ok: false, reason: 'conflict', message: 'the session advanced before this death could commit' };
		}
	} catch {
		return { ok: false, reason: 'conflict', message: 'the session changed before this death could commit' };
	}
	return null;
}

/**
 * Runs `buildChallengeDeathStatements` and commits it as ONE atomic write
 * (O4). Reclassifies a failed commit via `classifyChallengeDeathFailure`
 * rather than letting a lost-race constraint violation surface as a raw
 * throw.
 */
export async function executeChallengeDeath(input: ChallengeDeathInput): Promise<ChallengeDeathOutcome> {
	const built = await buildChallengeDeathStatements(input);
	if (!built.ok) return built;

	try {
		await runCampaignAtomic(input.db, built.statements);
	} catch (cause) {
		const classified = await classifyChallengeDeathFailure(input, {
			characterVersion: built.expectedCharacterVersion,
			sessionVersion: built.expectedSessionVersion
		});
		if (classified) return classified;
		throw cause;
	}

	return {
		ok: true,
		sessionVersion: built.nextSessionVersion,
		characterVersion: built.nextCharacterVersion,
		endedTenureId: input.tenureId
	};
}

// ---------------------------------------------------------------------------
// Boundary-only replacement admission (Increment 3 Task 5, O3)
// ---------------------------------------------------------------------------

/**
 * A REAL, DB-backed `SessionStatePort` (`$lib/server/campaign/session-state-
 * port.ts`'s interface) — closes the reviewer's ⚠️: exercising the Challenge
 * pending-join path only through a stub port (`activeSessionId: async () =>
 * 'session-a'`, `claimGuard: () => sql\`1 = 1\``) never proves
 * `attachAdventurer`'s real session-guard interacts correctly with the
 * appended join statements. `activeSessionId` reuses the same
 * `findOpenSessionForCampaign` query `/sync`'s own read path already trusts;
 * `claimGuard` proves, at commit time, that campaignId still has (or still
 * lacks) an open session matching what was observed — the same EXISTS/
 * NOT EXISTS shape `characterEligibilityClaim`'s existing membership/tenure
 * guards already use.
 */
export function challengeSessionStatePort(db: AppDb): SessionStatePort {
	return {
		activeSessionId: async (campaignId: string) => {
			const open = await findOpenSessionForCampaign(db, campaignId);
			return open?.sessionId ?? null;
		},
		claimGuard: (campaignId: string, activeSessionId: string | null) =>
			activeSessionId
				? exists(
						db
							.select({ id: playSessions.id })
							.from(playSessions)
							.where(
								and(
									eq(playSessions.id, activeSessionId),
									eq(playSessions.campaignId, campaignId),
									inArray(playSessions.status, ['active', 'frozen'])
								)
							)
					)
				: notExists(
						db
							.select({ id: playSessions.id })
							.from(playSessions)
							.where(and(eq(playSessions.campaignId, campaignId), inArray(playSessions.status, ['active', 'frozen'])))
					)
	};
}

/**
 * Builds the (Drizzle-compatible) statements needed to register `tenureId`
 * as a Challenge pending joiner in `sessionId` — `[]` ONLY for the genuine
 * "nothing to do" case: no active Challenge round, or `tenureId` is already
 * known (already an active participant or already pending —
 * `admitPendingJoinTenure` is idempotent, signaled by returning the SAME
 * state reference unchanged). Intended as the `buildChallengeJoinStatements`
 * callback `$lib/server/campaign/tenure.ts`'s `attachAdventurer` accepts, so
 * tenure creation and pending-join registration commit in ONE transaction.
 *
 * Review Important 3: every OTHER early exit (the session load throwing, a
 * non-`'active'` status) now THROWS instead of silently returning `[]`. The
 * previous behavior conflated "nothing to do" with "could not determine,
 * silently drop the join" — a transient load failure or an integrity error
 * would commit the tenure with no pending-join registration and no signal
 * that anything was skipped. `attachAdventurer` awaits this callback OUTSIDE
 * its own try/catch, so a throw here now fails the WHOLE attach before any
 * statement runs, rather than silently admitting a tenure the session can
 * never see.
 */
export async function buildPendingChallengeJoinStatements(input: {
	db: AppDb;
	sessionId: string;
	tenureId: string;
	actorUserId: string;
}): Promise<CampaignAtomicStatement[]> {
	// Deliberately NOT wrapped in try/catch — a load failure means "could not
	// determine," not "nothing to do" (Important 3).
	const loaded = await loadSessionForReduce(input.db, input.sessionId);
	if (loaded.status !== 'active') {
		// Typed so `attachAdventurer` can surface a `'session-not-active'` result
		// rather than a 500 (branch-fix I3 / ledger O11 item 1).
		throw new ChallengeJoinSessionNotActiveError(
			`buildPendingChallengeJoinStatements: session ${input.sessionId} is not active (status: ${loaded.status}) — cannot determine whether to register a pending Challenge join`
		);
	}

	const catalog = toSessionEngineRuntime(loaded.runtimeContent).catalog;
	// Branch-fix I4: register the joiner's owning userId AT admission, so the
	// next `cleanupRound` can admit the pending tenure without the caller having
	// to re-supply `options.tenureOwners` (the UI sends none). `actorUserId` is
	// the attaching player — the owner of the new tenure.
	const reduceResult = admitPendingJoinTenure(loaded.engineState, input.tenureId, input.actorUserId, catalog);
	if (!reduceResult.ok) {
		// Unreachable in practice — `admitPendingJoinTenure` never rejects —
		// but a rejection here is a reducer bug, not "nothing to do."
		throw new Error(`buildPendingChallengeJoinStatements: unexpected rejection: ${reduceResult.rejection.message}`);
	}
	if (reduceResult.state === loaded.engineState) {
		// Genuinely "nothing to do": no active Challenge round, or `tenureId`
		// is already known — a real, intended no-op.
		return [];
	}

	const nextVersion = loaded.currentVersion + 1;
	const finalState: SessionEngineStateV1 = { ...reduceResult.state, version: nextVersion };
	const { publicFragment, serverFragment, privateFragmentsByRecipient } = splitEngineState(
		finalState,
		loaded.shuffleSeed,
		loaded.gmUserId,
		loaded.recipientUserIds
	);

	const statements: CampaignAtomicStatement[] = [
		// Review Critical 1 / Important 2: same serialization claim as the
		// death path — without it, a racing `SessionCommand` could silently
		// overwrite this join registration (or vice versa), both reporting
		// success.
		sessionVersionClaimStatement(input.db, {
			sessionId: input.sessionId,
			actorUserId: input.actorUserId,
			commandType: 'challenge-pending-join',
			expectedVersion: loaded.currentVersion,
			now: new Date()
		}),
		input.db
			.update(playSessions)
			.set({
				version: nextVersion,
				phase: finalState.phase,
				procedureId: finalState.procedure?.procedureId ?? null,
				publicStateJson: JSON.stringify(publicFragment)
			})
			.where(and(eq(playSessions.id, input.sessionId), eq(playSessions.version, loaded.currentVersion))),
		input.db
			.update(sessionServerStates)
			.set({ sessionVersion: nextVersion, serverStateJson: JSON.stringify(serverFragment) })
			.where(and(eq(sessionServerStates.sessionId, input.sessionId), eq(sessionServerStates.sessionVersion, loaded.currentVersion)))
	];
	for (const [recipientUserId, fragment] of privateFragmentsByRecipient) {
		statements.push(
			input.db
				.update(sessionPrivateStates)
				.set({ sessionVersion: nextVersion, privateStateJson: JSON.stringify(fragment) })
				.where(
					and(
						eq(sessionPrivateStates.sessionId, input.sessionId),
						eq(sessionPrivateStates.recipientUserId, recipientUserId),
						eq(sessionPrivateStates.sessionVersion, loaded.currentVersion)
					)
				)
		);
	}
	return statements;
}
