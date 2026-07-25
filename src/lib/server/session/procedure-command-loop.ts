/**
 * The shared command execution loop for ADDITIVE procedure command surfaces
 * (Increment 4 Task 3).
 *
 * Increment 3 established the "mirror `command-service.ts` and document it"
 * convention, and Increment 4 Task 2 followed it once more. At the fourth copy
 * of the same ~280 lines — authorize, strict-parse, commandId+hash idempotency,
 * load-reduce-commit under a version claim, retry a lost race, persist a
 * rejection — that convention stops paying for itself: the guided test and Camp
 * surfaces differ only in their envelope schema, their reduce context, and their
 * dispatcher, so those three are what an adapter supplies and everything else
 * lives here exactly once.
 *
 * This loop deliberately does NOT cover the two services with genuinely special
 * cases: `command-service.ts` (structural commands hard-reject on a stale
 * `expectedStructuralVersion`, and it owns the Challenge death path) and
 * `challenge-command-service.ts` (server-boundary roster and enemy-catalog
 * validation). Folding those in would mean parameterizing the differences that
 * actually matter, which is how a shared helper becomes worse than the
 * duplication it replaced.
 *
 * No procedure command reaching this loop is "structural": every one retries on
 * a lost version-claim race rather than hard-rejecting, and none of their
 * envelopes carries a client-supplied structural precondition.
 *
 * Never imports `@sveltejs/kit` — no HTTP status codes in this layer.
 */

import { nanoid } from 'nanoid';
import type { AppDb } from '$lib/server/db';
import { runAtomic, isUniqueConstraintError, type AppDbContext, type AtomicStatement } from '$lib/server/db/atomic';
import { sha256Hex, canonicalJsonStringify } from '$lib/server/content/canonical-json';
import { SessionInvariantError } from '$lib/engine/session/invariants';
import { makeRng } from '$lib/engine/rng';
import type { Rng } from '$lib/engine/rng';
import type { ReduceResult } from '$lib/engine/session/result';
import { buildResolveIntentStatements, toAtomicStatements } from '$lib/server/character/resource-write';
import { evaluateResolveSpend, type ResolveSpend } from './command-service';
import {
	buildAcceptedCommandStatements,
	buildRejectedCommandStatements,
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
	SessionCommandEnvelope,
	SessionEngineStateV1,
	SessionEvent,
	SessionRejection
} from '$lib/types/session';

const MAX_ATTEMPTS = 4;
const FROZEN_MESSAGE = 'session frozen due to an internal error; contact the GM';

export type ProcedureCommandOutcome =
	| { ok: true; resultingVersion: number }
	| { ok: false; code: CommandRejectionCode; message: string };

export type ProcedureReduceResult = ReduceResult<SessionEngineStateV1, SessionEvent, SessionRejection>;

/**
 * What a procedure surface supplies. Everything else about executing a command
 * is identical across surfaces and lives in `executeProcedureCommand`.
 */
export interface ProcedureCommandAdapter<TCommand, TContext> {
	/** Used in log lines only, e.g. `guided-test` / `camp`. */
	label: string;
	/** Strict-parses the untrusted envelope. Returning `ok: false` yields a flat
	 * `malformed command envelope` — never a schema path, which could disclose
	 * the shape of a surface the caller is probing. */
	parseEnvelope(raw: unknown): { ok: true; envelope: SessionCommandEnvelope<TCommand> } | { ok: false };
	/**
	 * Whether `command` is the one that causes a character resource write. Omit
	 * for a surface that never spends: the loop then refuses ANY envelope
	 * carrying the reconfirmation pair, which is the correct answer for a surface
	 * with nothing to buy.
	 */
	spendsResolve?(command: TCommand): boolean;
	/** Message used when the envelope's spend pair and the command disagree. */
	spendMismatchMessage?: string;
	/** Builds the procedure's own reduce context from the loaded session. May
	 * read the DB (materials) and must use the supplied `rng`, never its own. */
	buildContext(input: {
		db: AppDb;
		campaignId: string;
		actor: SessionActor;
		loaded: LoadedSession;
		rng: Rng;
	}): Promise<TContext>;
	/** Dispatches the command. */
	apply(state: SessionEngineStateV1, command: TCommand, context: TContext): ProcedureReduceResult;
}

export interface ExecuteProcedureCommandInput {
	dbContext: AppDbContext;
	campaignId: string;
	sessionId: string;
	/** Already authenticated by the caller (the HTTP route); this loop only
	 * authorizes it against campaign membership. */
	actorUserId: string;
	/** Not yet parsed or trusted. */
	envelope: unknown;
}

export interface ExecuteProcedureCommandResult {
	/** `null` only when the actor is not a member of this campaign. */
	actor: SessionActor | null;
	outcome: ProcedureCommandOutcome;
	/**
	 * True on the paths where a caller must NOT build fresh projections: there is
	 * no such session for this caller, or the session was just frozen by this
	 * call. Preserves the existing services' behavior of returning null
	 * projections there rather than projecting a session the caller should not
	 * see (or that just failed to load).
	 */
	suppressProjections: boolean;
}

/** `hash(stored seed + sessionVersion + attempt)` — the same derivation every
 * other service uses, now in one place. */
function deriveAttemptSeed(shuffleSeedHex: string, sessionVersion: number, attempt: number): string {
	return sha256Hex(`${shuffleSeedHex}:${sessionVersion}:${attempt}`);
}

export async function executeProcedureCommand<TCommand extends { type: string }, TContext>(
	input: ExecuteProcedureCommandInput,
	adapter: ProcedureCommandAdapter<TCommand, TContext>
): Promise<ExecuteProcedureCommandResult> {
	const { dbContext, campaignId, sessionId, actorUserId } = input;
	const db = dbContext.db as unknown as AppDb;

	const actor = await resolveSessionActor(db, campaignId, actorUserId);
	if (!actor) {
		return {
			actor: null,
			outcome: { ok: false, code: 'not-authorized', message: 'actor is not a member of this campaign' },
			suppressProjections: true
		};
	}

	const parsed = adapter.parseEnvelope(input.envelope);
	if (!parsed.ok) {
		return {
			actor,
			outcome: { ok: false, code: 'illegal-command', message: 'malformed command envelope' },
			suppressProjections: false
		};
	}
	const envelope = parsed.envelope;
	const requestHash = sha256Hex(canonicalJsonStringify(envelope.command));

	// The reconfirmation pair belongs to exactly the command that spends. Any
	// other command carrying it — or a spending command omitting it — is refused
	// before anything is read, drawn, or persisted.
	const carriesSpend = envelope.expectedResolveCurrent !== undefined;
	const shouldSpend = adapter.spendsResolve?.(envelope.command) ?? false;
	if (carriesSpend !== shouldSpend) {
		return {
			actor,
			outcome: {
				ok: false,
				code: 'illegal-command',
				message:
					adapter.spendMismatchMessage ??
					'this command may not spend a character resource, and one that does must carry the reconfirmation pair'
			},
			suppressProjections: false
		};
	}

	const initialDuplicate = await resolveDuplicateOutcome(db, sessionId, envelope, requestHash);
	if (initialDuplicate) return { actor, outcome: initialDuplicate, suppressProjections: false };

	let lastKnownVersion = envelope.observedSessionVersion;

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const summary = await loadSessionSummary(db, sessionId);
		if (!summary || summary.campaignId !== campaignId) {
			return {
				actor,
				outcome: { ok: false, code: 'illegal-command', message: 'session not found' },
				suppressProjections: true
			};
		}
		lastKnownVersion = summary.version;

		if (summary.status !== 'active') {
			const outcome = await persistRejectionOrReplay(dbContext, db, sessionId, envelope, actorUserId, requestHash, summary.version, {
				code: 'illegal-command',
				message: `session is ${summary.status}, no commands are accepted`
			});
			return { actor, outcome, suppressProjections: false };
		}

		let loaded: LoadedSession;
		try {
			loaded = await loadSessionForReduce(db, sessionId);
		} catch (cause) {
			if (cause instanceof SessionLoadIntegrityError) {
				await freezeSessionForFailure(dbContext, {
					sessionId,
					campaignId,
					reason: 'load-integrity-failure',
					expectedVersion: summary.version
				});
				return {
					actor,
					outcome: { ok: false, code: 'illegal-command', message: FROZEN_MESSAGE },
					suppressProjections: true
				};
			}
			if (cause instanceof SessionNotFoundError) {
				return {
					actor,
					outcome: { ok: false, code: 'illegal-command', message: 'session not found' },
					suppressProjections: true
				};
			}
			throw cause;
		}
		lastKnownVersion = loaded.currentVersion;

		// Evaluated BEFORE the reduce so a refused purchase never moves a card.
		// Re-read on every attempt: a retry that lost a session version race may
		// also have lost a character version race.
		let resolveSpend: ResolveSpend | null = null;
		if (carriesSpend) {
			const evaluated = await evaluateResolveSpend(db, campaignId, sessionId, actorUserId, {
				observedCharacterVersion: envelope.observedCharacterVersion as number,
				expectedResolveCurrent: envelope.expectedResolveCurrent as number,
				commandType: envelope.command.type
			});
			// Deliberately NOT persisted as a rejection row: the client's whole job
			// on a changed resource is to show the current numbers and ask again, and
			// a persisted rejection under this commandId would make the reconfirmed
			// retry replay the stale refusal. Nothing was written.
			if (!evaluated.ok) return { actor, outcome: evaluated.outcome, suppressProjections: false };
			resolveSpend = evaluated.spend;
		}

		const rng = makeRng(deriveAttemptSeed(loaded.shuffleSeed, loaded.currentVersion, attempt));
		const context = await adapter.buildContext({ db, campaignId, actor, loaded, rng });

		let reduceResult: ProcedureReduceResult;
		try {
			reduceResult = adapter.apply(loaded.engineState, envelope.command, context);
		} catch (cause) {
			if (cause instanceof SessionInvariantError) {
				await freezeSessionForFailure(dbContext, {
					sessionId,
					campaignId,
					reason: 'invariant-violation',
					expectedVersion: loaded.currentVersion
				});
				return {
					actor,
					outcome: { ok: false, code: 'illegal-command', message: FROZEN_MESSAGE },
					suppressProjections: true
				};
			}
			throw cause;
		}

		if (!reduceResult.ok) {
			const outcome = await persistRejectionOrReplay(
				dbContext,
				db,
				sessionId,
				envelope,
				actorUserId,
				requestHash,
				loaded.currentVersion,
				reduceResult.rejection
			);
			return { actor, outcome, suppressProjections: false };
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
			structuralPreconditionVersion: null,
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
			// ONE atomic unit: the command claim, the session fragments, the events,
			// AND the character's narrow resource write. A spend that commits without
			// what it bought is the partial purchase Task 1 forbids.
			statements.push(...toAtomicStatements(buildResolveIntentStatements(db, resolveSpend.intent, resolveSpend.context)));
		}

		try {
			await runAtomic(dbContext, statements);
			await recordFreshCursorHintAfterCommit(db, campaignId);
			return {
				actor,
				outcome: { ok: true, resultingVersion: loaded.currentVersion + 1 },
				suppressProjections: false
			};
		} catch (cause) {
			// A lost resource claim fails the batch through its FK receipt, not a
			// unique index, so it would otherwise surface as a 500. Re-evaluate
			// first: a value that genuinely moved is the ordinary reconfirmation
			// path, not an internal error.
			if (resolveSpend) {
				const reEvaluated = await evaluateResolveSpend(db, campaignId, sessionId, actorUserId, {
					observedCharacterVersion: envelope.observedCharacterVersion as number,
					expectedResolveCurrent: envelope.expectedResolveCurrent as number,
					commandType: envelope.command.type
				});
				if (!reEvaluated.ok) return { actor, outcome: reEvaluated.outcome, suppressProjections: false };
			}
			if (!isUniqueConstraintError(cause)) throw cause;

			const duplicate = await resolveDuplicateOutcome(db, sessionId, envelope, requestHash);
			if (duplicate) return { actor, outcome: duplicate, suppressProjections: false };
			// Someone else claimed this version first — loop back and retry.
		}
	}

	const outcome = await persistRejectionOrReplay(dbContext, db, sessionId, envelope, actorUserId, requestHash, lastKnownVersion, {
		code: 'retry-exhausted',
		message: `command could not be committed after ${MAX_ATTEMPTS} attempts`
	});
	return { actor, outcome, suppressProjections: false };
}

async function resolveDuplicateOutcome<TCommand>(
	db: AppDb,
	sessionId: string,
	envelope: SessionCommandEnvelope<TCommand>,
	requestHash: string
): Promise<ProcedureCommandOutcome | null> {
	const existing = await findSessionCommand(db, sessionId, envelope.commandId);
	if (!existing) return null;

	if (existing.requestHash !== requestHash) {
		return { ok: false, code: 'command-id-reused', message: 'this commandId was already used for a different request' };
	}
	return existing.status === 'accepted'
		? { ok: true, resultingVersion: existing.resultingVersion as number }
		: { ok: false, ...(JSON.parse(existing.outcomeMetadataJson) as { code: CommandRejectionCode; message: string }) };
}

async function persistRejectionOrReplay<TCommand extends { type: string }>(
	dbContext: AppDbContext,
	db: AppDb,
	sessionId: string,
	envelope: SessionCommandEnvelope<TCommand>,
	actorUserId: string,
	requestHash: string,
	expectedVersion: number,
	rejection: SessionRejection
): Promise<ProcedureCommandOutcome> {
	try {
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
				structuralPreconditionVersion: null,
				expectedVersion,
				rejection,
				now: new Date()
			})
		);
	} catch (cause) {
		if (isUniqueConstraintError(cause)) {
			const duplicate = await resolveDuplicateOutcome(db, sessionId, envelope, requestHash);
			if (duplicate) return duplicate;
		}
		throw cause;
	}
	return { ok: false, code: rejection.code, message: rejection.message };
}
