/**
 * The guided test-of-fate command execution loop (Increment 4 Task 2). Mirrors
 * `challenge-command-service.ts` — same authorization, envelope strict-parse,
 * commandId+hash idempotency, pinned-runtime reduce, and atomic
 * commit-with-version-claim discipline — but dispatches through
 * `applyGuidedTestCommand` against the ADDITIVE `GuidedTestCommand` surface
 * rather than the frozen `SessionCommand` union.
 *
 * ## The one thing this loop does that the Challenge loop does not
 *
 * `purchase-test-favor` causes a CHARACTER write. Ch1 makes buying favor a
 * pre-draw purchase, so the spend and the draw it paid for must be indivisible:
 * the spend is evaluated BEFORE the reduce (a refused purchase never draws a
 * card) and its statements are spliced into the SAME atomic batch as the command
 * claim, session fragments, and events. `evaluateResolveSpend` is reused
 * verbatim from `command-service.ts` rather than reimplemented — this is a
 * security-sensitive path and two copies would drift.
 *
 * A refused spend is deliberately NOT persisted as a rejection row, for the
 * reason `command-service.ts` documents: the client's whole job on a changed
 * resource is to show the current numbers and ask again, and a persisted
 * rejection under this commandId would make the reconfirmed retry replay the
 * stale refusal.
 *
 * No guided-test command is "structural": every one is retried on a lost
 * version-claim race rather than hard-rejecting, and the schema carries no
 * client-supplied structural precondition.
 *
 * Never imports `@sveltejs/kit` — no HTTP status codes in this layer.
 */

import { nanoid } from 'nanoid';
import type { AppDb } from '$lib/server/db';
import { runAtomic, isUniqueConstraintError, type AppDbContext, type AtomicStatement } from '$lib/server/db/atomic';
import { sha256Hex, canonicalJsonStringify } from '$lib/server/content/canonical-json';
import { toSessionEngineRuntime } from '$lib/server/content/session-runtime';
import { SessionInvariantError } from '$lib/engine/session/invariants';
import { makeRng } from '$lib/engine/rng';
import { projectForActor, type SessionProjection } from '$lib/engine/session/projection';
import { toAtomicStatements, buildResolveIntentStatements } from '$lib/server/character/resource-write';
import { applyGuidedTestCommand, spendsResolve, type GuidedTestCommand } from '$lib/engine/session/procedures/guided-test-command';
import type { GuidedTestControl, GuidedTestProjection } from '$lib/engine/session/procedures/guided-test-projection';
import { loadTableProjectionsForActor } from './table-projections';
import { TEST_OF_FATE_PROCEDURE_ID, type GuidedTestMaterials, type GuidedTestReduceContext } from '$lib/engine/session/procedures/test-of-fate';
import { guidedTestCommandEnvelopeSchema } from '$lib/schemas/guided-test-command.schema';
import { loadGuidedTestMaterials } from './guided-test-materials';
import { evaluateResolveSpend, type ResolveSpend } from './command-service';
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
	SessionCommandEnvelope,
	SessionEngineStateV1,
	SessionProjectionEnvelope,
	SessionRejection
} from '$lib/types/session';
import type { TarotProcedureDefinition } from '$lib/types/content-pack';

const MAX_ATTEMPTS = 4;
const FROZEN_MESSAGE = 'session frozen due to an internal error; contact the GM';

export type GuidedTestCommandOutcome =
	| { ok: true; resultingVersion: number }
	| { ok: false; code: CommandRejectionCode; message: string };

export interface ExecuteGuidedTestCommandInput {
	dbContext: AppDbContext;
	campaignId: string;
	sessionId: string;
	/** Already authenticated by the caller (the HTTP route); this service only
	 * authorizes it against campaign membership. */
	actorUserId: string;
	/** Not yet parsed/trusted — validated against
	 * `guidedTestCommandEnvelopeSchema` before anything else touches it. */
	envelope: unknown;
}

export interface ExecuteGuidedTestCommandResult {
	outcome: GuidedTestCommandOutcome;
	/** The actor's fresh GENERIC session projection, alongside the guided-test
	 * slice, so a client never reconciles two load paths for one session. */
	projection: SessionProjectionEnvelope<SessionProjection> | null;
	guidedTestProjection: GuidedTestProjection | null;
	/** The legal guided-test command set for `actor` right now — present even
	 * when no test is in flight, so the GM's "Call for a test" control has a
	 * server-computed answer to render from rather than a client guess. */
	guidedTestLegalCommands: GuidedTestControl[];
}

/** Mirrors `command-service.ts`/`challenge-command-service.ts`'s own
 * `deriveAttemptSeed` — kept in lockstep rather than reaching across module
 * boundaries for a one-line pure function. */
function deriveAttemptSeed(shuffleSeedHex: string, sessionVersion: number, attempt: number): string {
	return sha256Hex(`${shuffleSeedHex}:${sessionVersion}:${attempt}`);
}

/** The pinned `test-of-fate` definition. Read from the session's OWN pinned
 * runtime content, never the live bundle: a mid-campaign content update must
 * not change a live session's reshuffle boundary. */
function pinnedTestProcedure(procedures: readonly TarotProcedureDefinition[]): TarotProcedureDefinition {
	const found = procedures.find((procedure) => procedure.id === TEST_OF_FATE_PROCEDURE_ID);
	if (!found) {
		throw new SessionLoadIntegrityError(`pinned runtime content is missing the ${TEST_OF_FATE_PROCEDURE_ID} procedure`);
	}
	return found;
}

/**
 * Thin delegation to `table-projections.ts`'s single combined loader — see that
 * module's header for why one load builds every procedure's slice. Kept as a
 * named export so this service and its route never build a divergent projection.
 */
export async function loadGuidedTestProjectionsForActor(
	db: AppDb,
	sessionId: string,
	campaignId: string,
	actor: SessionActor
): Promise<{
	projection: SessionProjectionEnvelope<SessionProjection> | null;
	guidedTestProjection: GuidedTestProjection | null;
	guidedTestLegalCommands: GuidedTestControl[];
	loadFailure: 'not-found' | 'unloadable' | null;
}> {
	const { projection, guidedTestProjection, guidedTestLegalCommands, loadFailure } = await loadTableProjectionsForActor(
		db,
		sessionId,
		campaignId,
		actor
	);
	return { projection, guidedTestProjection, guidedTestLegalCommands, loadFailure };
}

export async function executeGuidedTestCommand(input: ExecuteGuidedTestCommandInput): Promise<ExecuteGuidedTestCommandResult> {
	const { dbContext, campaignId, sessionId, actorUserId } = input;
	const db = dbContext.db as unknown as AppDb;

	const actor = await resolveSessionActor(db, campaignId, actorUserId);
	if (!actor) {
		return {
			outcome: { ok: false, code: 'not-authorized', message: 'actor is not a member of this campaign' },
			projection: null,
			guidedTestProjection: null,
			guidedTestLegalCommands: []
		};
	}

	const parsed = guidedTestCommandEnvelopeSchema.safeParse(input.envelope);
	if (!parsed.success) {
		return {
			outcome: { ok: false, code: 'illegal-command', message: 'malformed command envelope' },
			...(await loadGuidedTestProjectionsForActor(db, sessionId, campaignId, actor))
		};
	}
	const envelope = parsed.data as unknown as SessionCommandEnvelope<GuidedTestCommand>;
	const requestHash = sha256Hex(canonicalJsonStringify(envelope.command));

	// The reconfirmation pair belongs to exactly one command. Any other command
	// carrying it is a client bug or an attempt to spend outside the purchase,
	// and is refused before anything is read, drawn, or persisted.
	const carriesSpend = envelope.expectedResolveCurrent !== undefined;
	if (carriesSpend !== spendsResolve(envelope.command)) {
		return {
			outcome: {
				ok: false,
				code: 'illegal-command',
				message: 'only the pre-draw favor purchase may spend Resolve, and it must carry the reconfirmation pair'
			},
			...(await loadGuidedTestProjectionsForActor(db, sessionId, campaignId, actor))
		};
	}

	const initialDuplicate = await resolveDuplicateOutcome(db, sessionId, campaignId, envelope, requestHash, actor);
	if (initialDuplicate) return initialDuplicate;

	let lastKnownVersion = envelope.observedSessionVersion;

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const summary = await loadSessionSummary(db, sessionId);
		if (!summary || summary.campaignId !== campaignId) {
			return {
				outcome: { ok: false, code: 'illegal-command', message: 'session not found' },
				projection: null,
				guidedTestProjection: null,
				guidedTestLegalCommands: []
			};
		}
		lastKnownVersion = summary.version;

		if (summary.status !== 'active') {
			const rejection: SessionRejection = {
				code: 'illegal-command',
				message: `session is ${summary.status}, no commands are accepted`
			};
			return await persistRejectionOrReplay(dbContext, db, campaignId, sessionId, envelope, actor, actorUserId, requestHash, summary.version, rejection);
		}

		let loaded: LoadedSession;
		try {
			loaded = await loadSessionForReduce(db, sessionId);
		} catch (cause) {
			if (cause instanceof SessionLoadIntegrityError) {
				await freezeSessionForFailure(dbContext, { sessionId, campaignId, reason: 'load-integrity-failure', expectedVersion: summary.version });
				return {
					outcome: { ok: false, code: 'illegal-command', message: FROZEN_MESSAGE },
					projection: null,
					guidedTestProjection: null,
					guidedTestLegalCommands: []
				};
			}
			if (cause instanceof SessionNotFoundError) {
				return {
					outcome: { ok: false, code: 'illegal-command', message: 'session not found' },
					projection: null,
					guidedTestProjection: null,
					guidedTestLegalCommands: []
				};
			}
			throw cause;
		}
		lastKnownVersion = loaded.currentVersion;

		// Evaluated BEFORE the reduce so a refused purchase never draws a card.
		// Re-read on every attempt: a retry that lost a session version race may
		// also have lost a character version race.
		let resolveSpend: ResolveSpend | null = null;
		if (carriesSpend) {
			const evaluated = await evaluateResolveSpend(db, campaignId, sessionId, actorUserId, {
				observedCharacterVersion: envelope.observedCharacterVersion as number,
				expectedResolveCurrent: envelope.expectedResolveCurrent as number,
				commandType: envelope.command.type
			});
			if (!evaluated.ok) {
				return {
					outcome: evaluated.outcome,
					...(await loadGuidedTestProjectionsForActor(db, sessionId, campaignId, actor))
				};
			}
			resolveSpend = evaluated.spend;
		}

		const materials: GuidedTestMaterials = await loadGuidedTestMaterials(db, campaignId);
		const rng = makeRng(deriveAttemptSeed(loaded.shuffleSeed, loaded.currentVersion, attempt));
		const runtime = toSessionEngineRuntime(loaded.runtimeContent);
		const context: GuidedTestReduceContext = {
			actor,
			runtime,
			rng,
			config: loaded.runtimeContent.tarot,
			materials,
			procedure: pinnedTestProcedure(loaded.runtimeContent.procedures)
		};

		let reduceResult: ReturnType<typeof applyGuidedTestCommand>;
		try {
			reduceResult = applyGuidedTestCommand(loaded.engineState, envelope.command, context);
		} catch (cause) {
			if (cause instanceof SessionInvariantError) {
				await freezeSessionForFailure(dbContext, { sessionId, campaignId, reason: 'invariant-violation', expectedVersion: loaded.currentVersion });
				return {
					outcome: { ok: false, code: 'illegal-command', message: FROZEN_MESSAGE },
					projection: null,
					guidedTestProjection: null,
					guidedTestLegalCommands: []
				};
			}
			throw cause;
		}

		if (!reduceResult.ok) {
			return await persistRejectionOrReplay(
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
			// AND the character's narrow Resolve write. A spend that commits without
			// the favor it bought is exactly the partial purchase Task 1 forbids.
			statements.push(...toAtomicStatements(buildResolveIntentStatements(db, resolveSpend.intent, resolveSpend.context)));
		}

		try {
			await runAtomic(dbContext, statements);
			await recordFreshCursorHintAfterCommit(db, campaignId);
			return {
				outcome: { ok: true, resultingVersion: loaded.currentVersion + 1 },
				...(await loadGuidedTestProjectionsForActor(db, sessionId, campaignId, actor))
			};
		} catch (cause) {
			// A lost Resolve claim fails the batch through its FK receipt, not a
			// unique index, so it would otherwise surface as a 500. Re-evaluate
			// first: a Resolve that genuinely moved is the ordinary reconfirmation
			// path, not an internal error.
			if (resolveSpend) {
				const reEvaluated = await evaluateResolveSpend(db, campaignId, sessionId, actorUserId, {
					observedCharacterVersion: envelope.observedCharacterVersion as number,
					expectedResolveCurrent: envelope.expectedResolveCurrent as number,
					commandType: envelope.command.type
				});
				if (!reEvaluated.ok) {
					return {
						outcome: reEvaluated.outcome,
						...(await loadGuidedTestProjectionsForActor(db, sessionId, campaignId, actor))
					};
				}
			}
			if (!isUniqueConstraintError(cause)) throw cause;

			const duplicate = await resolveDuplicateOutcome(db, sessionId, campaignId, envelope, requestHash, actor);
			if (duplicate) return duplicate;
			// Someone else claimed this version first — loop back and retry.
		}
	}

	const rejection: SessionRejection = {
		code: 'retry-exhausted',
		message: `command could not be committed after ${MAX_ATTEMPTS} attempts`
	};
	return await persistRejectionOrReplay(dbContext, db, campaignId, sessionId, envelope, actor, actorUserId, requestHash, lastKnownVersion, rejection);
}

async function resolveDuplicateOutcome(
	db: AppDb,
	sessionId: string,
	campaignId: string,
	envelope: SessionCommandEnvelope<GuidedTestCommand>,
	requestHash: string,
	actor: SessionActor
): Promise<ExecuteGuidedTestCommandResult | null> {
	const existing = await findSessionCommand(db, sessionId, envelope.commandId);
	if (!existing) return null;

	if (existing.requestHash !== requestHash) {
		return {
			outcome: { ok: false, code: 'command-id-reused', message: 'this commandId was already used for a different request' },
			...(await loadGuidedTestProjectionsForActor(db, sessionId, campaignId, actor))
		};
	}
	const outcome: GuidedTestCommandOutcome =
		existing.status === 'accepted'
			? { ok: true, resultingVersion: existing.resultingVersion as number }
			: { ok: false, ...(JSON.parse(existing.outcomeMetadataJson) as { code: CommandRejectionCode; message: string }) };
	return { outcome, ...(await loadGuidedTestProjectionsForActor(db, sessionId, campaignId, actor)) };
}

async function persistRejectionOrReplay(
	dbContext: AppDbContext,
	db: AppDb,
	campaignId: string,
	sessionId: string,
	envelope: SessionCommandEnvelope<GuidedTestCommand>,
	actor: SessionActor,
	actorUserId: string,
	requestHash: string,
	expectedVersion: number,
	rejection: SessionRejection
): Promise<ExecuteGuidedTestCommandResult> {
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
			const duplicate = await resolveDuplicateOutcome(db, sessionId, campaignId, envelope, requestHash, actor);
			if (duplicate) return duplicate;
		}
		throw cause;
	}
	return {
		outcome: { ok: false, code: rejection.code, message: rejection.message },
		...(await loadGuidedTestProjectionsForActor(db, sessionId, campaignId, actor))
	};
}
