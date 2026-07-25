/**
 * The Challenge command execution loop (Increment 3 Task 6). Mirrors
 * `command-service.ts`'s `executeCommand` — same authorization, envelope
 * strict-parse, commandId+hash idempotency, pinned-runtime reduce, and
 * atomic commit-with-version-claim discipline — but dispatches through
 * `applyChallengeCommand` (`command.ts`) instead of the generic
 * `reduceSession`, against the ADDITIVE `ChallengeCommand` surface rather
 * than the frozen `SessionCommand` union.
 *
 * No Challenge command is treated as "structural" the way
 * `advance-procedure`/`complete-procedure`/`end-round`/`apply-correction`
 * are in the generic loop: every Challenge command here is retried (up to
 * `MAX_ATTEMPTS`) on a lost version-claim race rather than hard-rejecting on
 * a stale `expectedStructuralVersion` — there is no client-supplied
 * structural precondition on this surface at all (the schema carries none).
 * A client that wants ordinary retry-safety reuses the same `commandId`
 * (O1); death remains its own, separately-wired, non-idempotency-keyed path
 * (O11) and is NOT reachable through this surface.
 *
 * Never imports `@sveltejs/kit` — no HTTP status codes in this layer (same
 * discipline as `command-service.ts`).
 */

import { nanoid } from 'nanoid';
import type { AppDb } from '$lib/server/db';
import { runAtomic, isUniqueConstraintError, type AppDbContext } from '$lib/server/db/atomic';
import { sha256Hex, canonicalJsonStringify } from '$lib/server/content/canonical-json';
import { toSessionEngineRuntime } from '$lib/server/content/session-runtime';
import { SessionInvariantError } from '$lib/engine/session/invariants';
import { makeRng } from '$lib/engine/rng';
import { projectForActor, type SessionProjection } from '$lib/engine/session/projection';
import { buildChallengeConfig } from '$lib/engine/session/procedures/challenge/schema';
import { readChallengeState, tenureIdForUser, type ChallengeReduceContext } from '$lib/engine/session/procedures/challenge/reducer';
import { DEFAULT_ENEMY_SIZE_ID, LARGER_THAN_HUMAN_SIZE_ID } from '$lib/engine/session/procedures/challenge/deal';
import { loadActiveChallengeRoster } from '$lib/server/campaign/page-data';
import { getDenizenThreats } from '$lib/server/content/loader';
import {
	applyChallengeCommand,
	buildChallengeModifierMaterials,
	legalChallengeCommands,
	type ChallengeCommand
} from '$lib/engine/session/procedures/challenge/command';
import { projectChallengeForActor, type ChallengeProjection } from '$lib/engine/session/procedures/challenge/projection';
import type { ChallengeModifierDerivationCaps } from '$lib/engine/session/procedures/challenge/modifiers';
import { NO_EQUIPMENT, resolveChallengeEquipmentCaps } from '$lib/server/campaign/challenge-equipment';
import { challengeCommandEnvelopeSchema } from '$lib/schemas/challenge-command.schema';
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

const MAX_ATTEMPTS = 4;
const FROZEN_MESSAGE = 'session frozen due to an internal error; contact the GM';

export type ChallengeCommandOutcome =
	| { ok: true; resultingVersion: number }
	| { ok: false; code: CommandRejectionCode; message: string };

export interface ExecuteChallengeCommandInput {
	dbContext: AppDbContext;
	campaignId: string;
	sessionId: string;
	/** Already authenticated by the caller (the HTTP route); this service
	 * only authorizes it against campaign membership. */
	actorUserId: string;
	/** Not yet parsed/trusted — validated against
	 * `challengeCommandEnvelopeSchema` before anything else touches it. */
	envelope: unknown;
}

export interface ExecuteChallengeCommandResult {
	outcome: ChallengeCommandOutcome;
	/** The actor's fresh GENERIC session projection — present alongside
	 * `challengeProjection` so a client never has to reconcile two different
	 * load paths for what is, underneath, one session. */
	projection: SessionProjectionEnvelope<SessionProjection> | null;
	/** The actor's fresh Challenge-specific projection slice (`projection.ts`
	 * in the Challenge procedure) — `null` whenever no Challenge round is
	 * active or the session's fragments could not be loaded. */
	challengeProjection: ChallengeProjection | null;
	/** The full legal Challenge command set for `actor` right now — see
	 * `loadChallengeProjectionsForActor`'s doc comment (present even before
	 * any round exists, so the GM's "Begin Challenge" control has something
	 * server-computed to render from). */
	challengeLegalCommands: ChallengeCommand['type'][];
}

/** `HMAC/hash of stored seed + sessionVersion + attempt` — mirrors
 * `command-service.ts`'s own `deriveAttemptSeed` (not exported there; kept
 * in lockstep rather than reaching across module boundaries for a five-line
 * pure function). */
function deriveAttemptSeed(shuffleSeedHex: string, sessionVersion: number, attempt: number): string {
	return sha256Hex(`${shuffleSeedHex}:${sessionVersion}:${attempt}`);
}

/** Resolves the Challenge-relevant equipment caps for `actor` against
 * `loaded`'s CURRENT engine state: a player's own tenure (if they hold one in
 * the active round), or `NO_EQUIPMENT` for the GM/a non-participant — never
 * fabricated (O2), always the tenure's real persisted equipment
 * (`challenge-equipment.ts`). */
async function resolveEquipmentCapsFor(db: AppDb, state: SessionEngineStateV1, actor: SessionActor) {
	if (actor.kind !== 'player') return NO_EQUIPMENT;
	const challenge = readChallengeState(state);
	if (!challenge) return NO_EQUIPMENT;
	const tenureId = tenureIdForUser(challenge, actor.userId);
	if (!tenureId) return NO_EQUIPMENT;
	return resolveChallengeEquipmentCaps(db, tenureId);
}

function modifierCapsFrom(materials: ReturnType<typeof buildChallengeModifierMaterials>): ChallengeModifierDerivationCaps {
	return {
		counselMaxUsesPerRound: materials.counsel.maxUsesPerRound,
		guardianAngelMaxInstances: materials.guardianAngel.maxInstances,
		hasBow: materials.hasBow,
		hasShield: materials.hasShield
	};
}

/**
 * Builds BOTH the generic and Challenge-specific fresh projections for
 * `actor` — exported for Task 6's HTTP layer (GET reads, `/sync`, the
 * table's SSR load) exactly as `command-service.ts`'s `loadProjectionForActor`
 * is, so no route ever builds (and potentially leaks) its own divergent
 * projection.
 */
export async function loadChallengeProjectionsForActor(
	db: AppDb,
	sessionId: string,
	campaignId: string,
	actor: SessionActor
): Promise<{
	projection: SessionProjectionEnvelope<SessionProjection> | null;
	challengeProjection: ChallengeProjection | null;
	/**
	 * The full legal Challenge command set for `actor` RIGHT NOW, computed
	 * independent of whether a round is active — `challengeProjection` is
	 * `null` before any round exists (there is no `ChallengeStateV1` yet), but
	 * the GM still needs a server-computed answer to "may I begin one?"
	 * (O1: never guessed client-side). `legalChallengeCommands` already
	 * handles the no-round case correctly (`['begin-challenge']` for the GM,
	 * `[]` otherwise), so this is the SAME derivation, just also exposed when
	 * `challengeProjection` has nothing else to carry.
	 */
	challengeLegalCommands: ChallengeCommand['type'][];
	/**
	 * Why `projection` is null, when it is. `'not-found'` means there is no
	 * such session *for this caller* — genuinely absent, or belonging to
	 * another campaign (deliberately conflated, so this never confirms the
	 * existence of a session outside the requested campaign). `'unloadable'`
	 * means the session EXISTS and is open but cannot be projected: pinned
	 * content that no longer satisfies today's schema, a fragment at the
	 * wrong version, a corrupt payload.
	 *
	 * The distinction is not cosmetic. Callers previously saw one
	 * indistinguishable `projection: null` for both and rendered "no session
	 * is open" over a session that was very much open — leaving the GM with a
	 * "Start session" button whose action could only ever refuse, since the
	 * unloadable session still holds the campaign's one open-session slot.
	 * `null` here means "no failure": either a live projection, or a caller
	 * that never got as far as asking.
	 */
	loadFailure: 'not-found' | 'unloadable' | null;
}> {
	// Branch-fix I6's campaign check, hoisted AHEAD of the full load (which
	// parses every fragment and so can fail for reasons of its own). Deciding
	// ownership from the cheap summary read first means an out-of-campaign
	// caller always gets a flat 'not-found', never an 'unloadable' that would
	// confirm the session id exists somewhere. The redundant post-load check
	// below stays as defence in depth.
	const summary = await loadSessionSummary(db, sessionId);
	if (!summary || summary.campaignId !== campaignId) {
		return { projection: null, challengeProjection: null, challengeLegalCommands: [], loadFailure: 'not-found' };
	}

	let loaded: LoadedSession;
	try {
		loaded = await loadSessionForReduce(db, sessionId);
	} catch (cause) {
		if (cause instanceof SessionNotFoundError) {
			return { projection: null, challengeProjection: null, challengeLegalCommands: [], loadFailure: 'not-found' };
		}
		// Integrity failures used to be swallowed in silence — the one class of
		// failure an operator most needs to see, since it never resolves on its
		// own and leaves the campaign wedged. Logged (not persisted, not shown
		// to the client) because the message carries schema paths, not secrets.
		if (cause instanceof SessionLoadIntegrityError) {
			console.error(`[challenge] session ${sessionId} is unloadable: ${cause.message}`);
		} else {
			console.error('[challenge] unexpected error loading session for projections', cause);
		}
		return { projection: null, challengeProjection: null, challengeLegalCommands: [], loadFailure: 'unloadable' };
	}

	// Branch-fix I6: the session must belong to the REQUESTED campaign. A GM of
	// campaign A holding a session id from campaign B would otherwise receive
	// B's full generic AND Challenge state through this loader (called before
	// `executeChallengeCommand`'s own `summary.campaignId !== campaignId` check
	// on the malformed-envelope and duplicate-lookup paths). Neither the generic
	// nor the Challenge slice may leak across campaigns.
	if (loaded.campaignId !== campaignId) {
		// 'not-found', not 'unloadable': the caller is outside this session's
		// campaign and must not learn that it exists at all.
		return { projection: null, challengeProjection: null, challengeLegalCommands: [], loadFailure: 'not-found' };
	}

	const runtime = toSessionEngineRuntime(loaded.runtimeContent);

	// Branch-fix I5: build and return the GENERIC projection first, wrapping
	// ONLY the Challenge slice below in its own catch. Previously the generic
	// projection AND `buildChallengeConfig` (which throws on missing Challenge
	// content) shared one try/catch, so a Challenge-only fault nulled the
	// generic projection for a NON-Challenge table — and `/sync`/SSR now route
	// every session through here.
	let genericProjection: SessionProjectionEnvelope<SessionProjection> | null;
	try {
		const projection = projectForActor(loaded.engineState, actor, runtime.catalog);
		const cursor = await campaignCursor(db, campaignId);
		genericProjection = { campaignCursor: cursor, sessionVersion: loaded.currentVersion, projection };
	} catch (cause) {
		if (!(cause instanceof SessionNotFoundError) && !(cause instanceof SessionLoadIntegrityError)) {
			console.error('[challenge] unexpected error building generic projection', cause);
		}
		genericProjection = null;
	}

	let challengeProjection: ChallengeProjection | null = null;
	let challengeLegalCommands: ChallengeCommand['type'][] = [];
	try {
		const config = buildChallengeConfig(loaded.runtimeContent.procedures, loaded.runtimeContent.formulas);
		const equipment = await resolveEquipmentCapsFor(db, loaded.engineState, actor);
		const materials = buildChallengeModifierMaterials(loaded.runtimeContent.modifiers, equipment);
		const modifierCaps = modifierCapsFrom(materials);
		challengeProjection = projectChallengeForActor(loaded.engineState, actor, runtime.catalog, config, modifierCaps);
		challengeLegalCommands = legalChallengeCommands(loaded.engineState, actor, config, modifierCaps);
	} catch (cause) {
		console.error('[challenge] unexpected error building Challenge projection slice', cause);
		challengeProjection = null;
		challengeLegalCommands = [];
	}

	// A generic projection that failed to build is the same fact as a session
	// that failed to load, as far as any caller is concerned: the session is
	// there and cannot be shown.
	return {
		projection: genericProjection,
		challengeProjection,
		challengeLegalCommands,
		loadFailure: genericProjection ? null : 'unloadable'
	};
}

/**
 * Server-boundary validation for the roster/enemy inputs the pure engine
 * cannot check itself (it has no DB and no denizen catalog):
 *
 * - **C2 (roster):** every tenure that will be SEATED this round must be a real
 *   active campaign tenure AND its owning user must be an actual session
 *   private-state recipient. Private-state rows are created once at session
 *   start from `memberUserIds`; a user who joined the campaign AFTER the session
 *   started has no such row, so dealing them a hand is a silent no-op UPDATE and
 *   the next Challenge command trips invariant #5 (every configured card must be
 *   present) and hard-freezes the session. Rejecting cleanly here turns that
 *   freeze into an ordinary `illegal-command`. (Recipients are keyed by USER, so
 *   a death/replacement — the SAME user attaching a new adventurer — passes,
 *   exactly as intended.)
 * - **I9 (enemy catalog):** `threat` must be a real `denizens.json` threat id
 *   (an unrecognized value silently scores a zero GM-hand bonus), and `size`
 *   must be one of the two recognized sentinels (there is no size catalog — only
 *   the `larger-than-human` distinction is mechanical).
 *
 * Returns a human-readable rejection message, or `null` when the command is
 * either not a roster/enemy-bearing command or fully valid.
 */
async function validateChallengeRosterInputs(
	db: AppDb,
	campaignId: string,
	recipientUserIds: readonly string[],
	command: ChallengeCommand,
	loadedState: SessionEngineStateV1
): Promise<string | null> {
	const validSizes = new Set([LARGER_THAN_HUMAN_SIZE_ID, DEFAULT_ENEMY_SIZE_ID]);
	const validThreats = new Set(getDenizenThreats().map((threat) => threat.id));

	function validateEnemyCatalog(enemyFacts: readonly { id: string; size: string; threat: string }[]): string | null {
		for (const enemy of enemyFacts) {
			if (!validThreats.has(enemy.threat)) {
				return `unknown enemy threat "${enemy.threat}" for ${enemy.id} — not a denizens.json threat id`;
			}
			if (!validSizes.has(enemy.size)) {
				return `unknown enemy size "${enemy.size}" for ${enemy.id} — expected "${DEFAULT_ENEMY_SIZE_ID}" or "${LARGER_THAN_HUMAN_SIZE_ID}"`;
			}
		}
		return null;
	}

	if (command.type === 'begin-challenge') {
		const roster = await loadActiveChallengeRoster(db, campaignId);
		const rosterOwnerByTenure = new Map(roster.map((entry) => [entry.tenureId, entry.userId]));
		const recipients = new Set(recipientUserIds);
		for (const tenureId of command.participantTenureIds) {
			const rosterOwner = rosterOwnerByTenure.get(tenureId);
			if (rosterOwner === undefined) {
				return `${tenureId} is not an active adventurer tenure in this campaign`;
			}
			const declaredOwner = command.tenureOwners[tenureId];
			if (declaredOwner !== rosterOwner) {
				return `tenure ${tenureId} owner does not match the active campaign roster`;
			}
			if (!recipients.has(rosterOwner)) {
				return `${tenureId}'s owner is not a session participant (they joined after the session started) and cannot be seated mid-session`;
			}
		}
		return validateEnemyCatalog(command.enemyFacts);
	}

	if (command.type === 'cleanup-round') {
		const enemyError = command.options?.enemyFacts ? validateEnemyCatalog(command.options.enemyFacts) : null;
		if (enemyError) return enemyError;

		// Every tenure `cleanupRound` will ADMIT next round (the current pending
		// joins) must have a recipient owner, or its dealt hand next round would
		// write to a nonexistent private-state row and freeze the session (C2).
		const challenge = readChallengeState(loadedState);
		if (!challenge || challenge.pendingJoinTenureIds.length === 0) return null;
		const effectiveOwners: Record<string, string> = { ...challenge.tenureOwners, ...(command.options?.tenureOwners ?? {}) };
		const recipients = new Set(recipientUserIds);
		const roster = await loadActiveChallengeRoster(db, campaignId);
		const rosterOwnerByTenure = new Map(roster.map((entry) => [entry.tenureId, entry.userId]));
		for (const tenureId of challenge.pendingJoinTenureIds) {
			const owner = effectiveOwners[tenureId];
			if (owner === undefined) {
				return `pending joiner ${tenureId} has no registered owner`;
			}
			const rosterOwner = rosterOwnerByTenure.get(tenureId);
			if (rosterOwner !== undefined && rosterOwner !== owner) {
				return `pending joiner ${tenureId} owner does not match the active campaign roster`;
			}
			if (!recipients.has(owner)) {
				return `pending joiner ${tenureId}'s owner is not a session participant and cannot be seated`;
			}
		}
		return null;
	}

	return null;
}

export async function executeChallengeCommand(input: ExecuteChallengeCommandInput): Promise<ExecuteChallengeCommandResult> {
	const { dbContext, campaignId, sessionId, actorUserId } = input;
	const db = dbContext.db as unknown as AppDb;

	const actor = await resolveSessionActor(db, campaignId, actorUserId);
	if (!actor) {
		return {
			outcome: { ok: false, code: 'not-authorized', message: 'actor is not a member of this campaign' },
			projection: null,
			challengeProjection: null,
			challengeLegalCommands: []
		};
	}

	const parsed = challengeCommandEnvelopeSchema.safeParse(input.envelope);
	if (!parsed.success) {
		return {
			outcome: { ok: false, code: 'illegal-command', message: 'malformed command envelope' },
			...(await loadChallengeProjectionsForActor(db, sessionId, campaignId, actor))
		};
	}
	const envelope = parsed.data as unknown as SessionCommandEnvelope<ChallengeCommand>;
	const requestHash = sha256Hex(canonicalJsonStringify(envelope.command));

	const initialDuplicate = await resolveDuplicateOutcome(db, sessionId, campaignId, envelope, requestHash, actor);
	if (initialDuplicate) return initialDuplicate;

	let lastKnownVersion = envelope.observedSessionVersion;

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const summary = await loadSessionSummary(db, sessionId);
		if (!summary || summary.campaignId !== campaignId) {
			return {
				outcome: { ok: false, code: 'illegal-command', message: 'session not found' },
				projection: null,
				challengeProjection: null,
				challengeLegalCommands: []
			};
		}
		lastKnownVersion = summary.version;

		if (summary.status !== 'active') {
			const rejection: SessionRejection = { code: 'illegal-command', message: `session is ${summary.status}, no commands are accepted` };
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
					challengeProjection: null,
					challengeLegalCommands: []
				};
			}
			if (cause instanceof SessionNotFoundError) {
				return {
					outcome: { ok: false, code: 'illegal-command', message: 'session not found' },
					projection: null,
					challengeProjection: null,
					challengeLegalCommands: []
				};
			}
			throw cause;
		}
		lastKnownVersion = loaded.currentVersion;

		// Branch-fix C2/I9: validate roster + enemy-catalog inputs against the
		// DB and content catalog the pure engine can't reach, BEFORE reducing —
		// a non-recipient owner or unknown threat/size must be a clean rejection,
		// never a downstream freeze or silent mis-score.
		const rosterError = await validateChallengeRosterInputs(db, campaignId, loaded.recipientUserIds, envelope.command, loaded.engineState);
		if (rosterError) {
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
				{ code: 'illegal-command', message: rosterError }
			);
		}

		const rng = makeRng(deriveAttemptSeed(loaded.shuffleSeed, loaded.currentVersion, attempt));
		const runtime = toSessionEngineRuntime(loaded.runtimeContent);
		const config = buildChallengeConfig(loaded.runtimeContent.procedures, loaded.runtimeContent.formulas);
		const context: ChallengeReduceContext = { actor, runtime, rng, config };
		const equipment = await resolveEquipmentCapsFor(db, loaded.engineState, actor);
		const materials = buildChallengeModifierMaterials(loaded.runtimeContent.modifiers, equipment);

		let reduceResult: ReturnType<typeof applyChallengeCommand>;
		try {
			reduceResult = applyChallengeCommand(loaded.engineState, envelope.command, materials, context);
		} catch (cause) {
			if (cause instanceof SessionInvariantError) {
				await freezeSessionForFailure(dbContext, { sessionId, campaignId, reason: 'invariant-violation', expectedVersion: loaded.currentVersion });
				return {
					outcome: { ok: false, code: 'illegal-command', message: FROZEN_MESSAGE },
					projection: null,
					challengeProjection: null,
					challengeLegalCommands: []
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
		const statements = buildAcceptedCommandStatements({
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

		try {
			await runAtomic(dbContext, statements);
			await recordFreshCursorHintAfterCommit(db, campaignId);
			return {
				outcome: { ok: true, resultingVersion: loaded.currentVersion + 1 },
				...(await loadChallengeProjectionsForActor(db, sessionId, campaignId, actor))
			};
		} catch (cause) {
			if (!isUniqueConstraintError(cause)) throw cause;

			const duplicate = await resolveDuplicateOutcome(db, sessionId, campaignId, envelope, requestHash, actor);
			if (duplicate) return duplicate;
			// Someone else claimed this version first — loop back and retry.
		}
	}

	const rejection: SessionRejection = { code: 'retry-exhausted', message: `command could not be committed after ${MAX_ATTEMPTS} attempts` };
	return await persistRejectionOrReplay(dbContext, db, campaignId, sessionId, envelope, actor, actorUserId, requestHash, lastKnownVersion, rejection);
}

async function resolveDuplicateOutcome(
	db: AppDb,
	sessionId: string,
	campaignId: string,
	envelope: SessionCommandEnvelope<ChallengeCommand>,
	requestHash: string,
	actor: SessionActor
): Promise<ExecuteChallengeCommandResult | null> {
	const existing = await findSessionCommand(db, sessionId, envelope.commandId);
	if (!existing) return null;

	if (existing.requestHash !== requestHash) {
		return {
			outcome: { ok: false, code: 'command-id-reused', message: 'this commandId was already used for a different request' },
			...(await loadChallengeProjectionsForActor(db, sessionId, campaignId, actor))
		};
	}
	const outcome: ChallengeCommandOutcome =
		existing.status === 'accepted'
			? { ok: true, resultingVersion: existing.resultingVersion as number }
			: { ok: false, ...(JSON.parse(existing.outcomeMetadataJson) as { code: CommandRejectionCode; message: string }) };
	return { outcome, ...(await loadChallengeProjectionsForActor(db, sessionId, campaignId, actor)) };
}

async function persistRejectionOrReplay(
	dbContext: AppDbContext,
	db: AppDb,
	campaignId: string,
	sessionId: string,
	envelope: SessionCommandEnvelope<ChallengeCommand>,
	actor: SessionActor,
	actorUserId: string,
	requestHash: string,
	expectedVersion: number,
	rejection: SessionRejection
): Promise<ExecuteChallengeCommandResult> {
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
		...(await loadChallengeProjectionsForActor(db, sessionId, campaignId, actor))
	};
}
