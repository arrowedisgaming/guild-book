/**
 * Session lifecycle: start, freeze-on-failure, GM recovery, and end (Task 5
 * brief Step 5 + task-title "recovery"). Freeze/recover/end are GM-only
 * (freeze-on-failure excepted — system-triggered) and go through the *same*
 * `session_commands` version-claim mechanism regular structural commands use
 * (amendment 8: "GM lifecycle freeze/recover/end are structural commands
 * through the same service" — now literal, not just patterned-after). This
 * matters for correctness, not just consistency: without a shared claim,
 * nothing serializes a lifecycle action against an in-flight
 * `executeCommand` attempt that read the session at the same version —
 * `endSession`'s cleanup could complete and then a stale command commit
 * could still land afterward, resurrecting deleted private state/secrets
 * into a session that's supposed to be gone. Claiming the next version (like
 * any other structural command) closes that race: whichever write commits
 * first wins the unique `(session_id, resulting_version)` slot, and the
 * loser's entire batch rolls back — never partially applies.
 *
 * Rejections are persisted the same way in-band command rejections are
 * (`persistLifecycleRejection` below, mirroring `command-service.ts`'s
 * `persistRejection`) for the same §6.5 auditability reason — except an
 * actor that isn't a campaign member at all (vs. a member who just isn't the
 * GM) is never persisted, matching `executeCommand`'s "can't safely form an
 * idempotency-adjacent record for a stranger" stance.
 */

import { randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';
import { and, eq, inArray } from 'drizzle-orm';
import type { AppDb } from '$lib/server/db';
import { runAtomic, isUniqueConstraintError, type AppDbContext } from '$lib/server/db/atomic';
import { campaignEvents, playSessions } from '$lib/server/db/schema';
import { canonicalDigest, canonicalJsonStringify } from '$lib/server/content/canonical-json';
import { compileSessionRuntimeContent, toSessionEngineRuntime } from '$lib/server/content/session-runtime';
import { getContentPack, getTarotProcedures } from '$lib/server/content/loader';
import { buildMajorDeck, buildPlayerDeck, shuffleDeck } from '$lib/engine/tarot-deck';
import { makeRng } from '$lib/engine/rng';
import { projectForActor } from '$lib/engine/session/projection';
import {
	buildEndSessionStatements,
	buildFreezeStatements,
	buildRecoverStatements,
	buildRejectedCommandStatements,
	buildStartSessionStatements,
	listActiveCampaignMemberUserIds,
	loadSessionForReduce,
	loadSessionSummary,
	resolveSessionActor,
	standardPrivateZonesForMember,
	standardPublicZones
} from './repository';
import type { SessionEngineStateV1, SessionRejection } from '$lib/types/session';

export type LifecycleRejectionCode = 'not-authorized' | 'illegal-command' | 'stale-structure';

/** Persists a rejected lifecycle action exactly like `command-service.ts`'s
 * `persistRejection` persists a rejected in-band command — same table, same
 * shape, so a rejected `endSession` shows up in the audit trail next to a
 * rejected `end-round`. Only called once an `actorUserId` and a real session
 * are known (never for "session not found" — there'd be no valid FK target
 * — and never for an actor who isn't a campaign member at all). */
async function persistLifecycleRejection(
	dbContext: AppDbContext,
	input: {
		sessionId: string;
		commandId: string;
		actorUserId: string;
		commandType: string;
		expectedVersion: number;
		rejection: SessionRejection;
		now: Date;
	}
): Promise<void> {
	await runAtomic(
		dbContext,
		buildRejectedCommandStatements({
			commandRowId: nanoid(),
			sessionId: input.sessionId,
			commandId: input.commandId,
			actorUserId: input.actorUserId,
			requestHash: canonicalDigest({ action: input.commandType }),
			commandType: input.commandType,
			clientObservedVersion: input.expectedVersion,
			structuralPreconditionVersion: input.expectedVersion,
			expectedVersion: input.expectedVersion,
			rejection: input.rejection,
			now: input.now
		})
	);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export interface StartSessionOptions {
	dbContext: AppDbContext;
	campaignId: string;
	actorUserId: string;
	now?: Date;
	/** Test-only override; production always generates one. */
	sessionId?: string;
	/** Test-only override so shuffles are reproducible; production always
	 * generates a fresh crypto-random seed (amendment 10). */
	shuffleSeed?: string;
}

export type StartSessionResult = { ok: true; sessionId: string; version: number } | { ok: false; code: LifecycleRejectionCode };

/**
 * Compiles and pins a fresh `SessionRuntimeContentV1`, freshly shuffles both
 * decks with a cryptographically random server seed (never exposed —
 * persisted only inside the server fragment's `shuffleSeed`, see
 * `repository.ts`'s `SessionServerFragmentV1`), seeds the standard zone set
 * every active campaign member and the GM need, and commits the whole start
 * atomically (circular-FK insert order — amendment 4). No version claim
 * needed here — the partial unique index `play_sessions_open_campaign_uq`
 * (one active/frozen session per campaign) already makes two concurrent
 * starts for the same campaign mutually exclusive at the DB level.
 */
export async function startSession(options: StartSessionOptions): Promise<StartSessionResult> {
	const db = options.dbContext.db as unknown as AppDb;

	const actor = await resolveSessionActor(db, options.campaignId, options.actorUserId);
	if (!actor || actor.kind !== 'gm') return { ok: false, code: 'not-authorized' };

	const openSession = await db
		.select({ id: playSessions.id })
		.from(playSessions)
		.where(and(eq(playSessions.campaignId, options.campaignId), inArray(playSessions.status, ['active', 'frozen'])))
		.get();
	if (openSession) return { ok: false, code: 'illegal-command' };

	const memberUserIds = await listActiveCampaignMemberUserIds(db, options.campaignId);
	const sequence = await nextSequence(db, options.campaignId);

	const pack = getContentPack();
	const proceduresFile = getTarotProcedures();
	const runtimeContent = compileSessionRuntimeContent({ pack, proceduresFile });

	const shuffleSeed = options.shuffleSeed ?? randomBytes(32).toString('hex');
	const rng = makeRng(shuffleSeed);
	const majorDraw = shuffleDeck(buildMajorDeck(pack.tarot), rng).map((card) => card.id);
	const playerDraw = shuffleDeck(buildPlayerDeck(pack.tarot), rng).map((card) => card.id);

	const sessionId = options.sessionId ?? nanoid();
	const now = options.now ?? new Date();

	const initialState: SessionEngineStateV1 = {
		schemaVersion: 1,
		sessionId,
		version: 1,
		phase: 'crawl',
		procedure: null,
		majorDraw,
		majorDiscard: [],
		playerDraw,
		playerDiscard: [],
		gmHand: [],
		privateZones: memberUserIds.flatMap(standardPrivateZonesForMember),
		publicZones: standardPublicZones(),
		pendingZones: [],
		reshuffleAtBoundary: { major: false, player: false }
	};

	const statements = buildStartSessionStatements({
		sessionId,
		campaignId: options.campaignId,
		sequence,
		contentPackId: runtimeContent.contentPackId,
		contentPackVersion: runtimeContent.contentPackVersion,
		contentDigest: runtimeContent.contentDigest,
		runtimeContent,
		initialState,
		shuffleSeed,
		gmUserId: actor.userId,
		memberUserIds,
		startedByUserId: actor.userId,
		now,
		idFactory: () => nanoid()
	});

	await runAtomic(options.dbContext, statements);
	return { ok: true, sessionId, version: 1 };
}

async function nextSequence(db: AppDb, campaignId: string): Promise<number> {
	const rows = await db.select({ sequence: playSessions.sequence }).from(playSessions).where(eq(playSessions.campaignId, campaignId));
	return rows.reduce((max, row) => Math.max(max, row.sequence), 0) + 1;
}

// ---------------------------------------------------------------------------
// Freeze-on-failure (called by command-service.ts on an unexpected
// invariant/load failure — brief Step 4's last paragraph)
// ---------------------------------------------------------------------------

export interface FreezeForFailureInput {
	sessionId: string;
	campaignId: string;
	/** A short, redacted, non-secret label — never a raw error message or
	 * stack trace, never a card id (amendment 8's "redacted recovery error"). */
	reason: string;
	/** The version the caller already confirmed the session was at (e.g. an
	 * invariant-violation caller already holds `loaded.currentVersion`).
	 * Falls back to a fresh `loadSessionSummary` read when omitted (the
	 * load-integrity-failure caller has no trustworthy `loaded` to reuse). */
	expectedVersion?: number;
	now?: Date;
}

/**
 * Claims the next version and flips status to `'frozen'`, exactly like an
 * accepted structural command. If the claim loses a race — another writer
 * (an ordinary command, or a concurrent freeze/recover/end) already claimed
 * that version — this is a no-op: the caller's own in-flight command attempt
 * is already returning a redacted rejection to its caller regardless of
 * whether the freeze itself lands, and a concurrent successful write is
 * itself evidence the session isn't uniformly broken. Never rethrows.
 */
export async function freezeSessionForFailure(dbContext: AppDbContext, input: FreezeForFailureInput): Promise<void> {
	const db = dbContext.db as unknown as AppDb;
	let expectedVersion = input.expectedVersion;
	if (expectedVersion === undefined) {
		const summary = await loadSessionSummary(db, input.sessionId);
		if (!summary) return;
		expectedVersion = summary.version;
	}

	const now = input.now ?? new Date();
	const statements = buildFreezeStatements({
		commandRowId: nanoid(),
		commandId: nanoid(),
		sessionId: input.sessionId,
		campaignId: input.campaignId,
		actorUserId: null,
		expectedVersion,
		reason: input.reason,
		now
	});

	try {
		await runAtomic(dbContext, statements);
	} catch (cause) {
		if (!isUniqueConstraintError(cause)) throw cause;
		// Lost the race — see doc comment above.
	}
}

// ---------------------------------------------------------------------------
// Recover
// ---------------------------------------------------------------------------

export interface RecoverSessionOptions {
	dbContext: AppDbContext;
	campaignId: string;
	sessionId: string;
	actorUserId: string;
	/** When supplied, the GM's confirmed structural version — mismatch hard
	 * rejects rather than recovering a session the GM hasn't actually
	 * reviewed. Optional because a GM recovering from a bare "it's frozen"
	 * notice may not have a version to hand. */
	expectedVersion?: number;
	now?: Date;
}

export type RecoverSessionResult = { ok: true } | { ok: false; code: LifecycleRejectionCode };

export async function recoverSession(options: RecoverSessionOptions): Promise<RecoverSessionResult> {
	const db = options.dbContext.db as unknown as AppDb;
	const now = options.now ?? new Date();
	const commandId = nanoid();

	const actor = await resolveSessionActor(db, options.campaignId, options.actorUserId);
	if (!actor) return { ok: false, code: 'not-authorized' };

	const summary = await loadSessionSummary(db, options.sessionId);
	if (!summary || summary.campaignId !== options.campaignId) return { ok: false, code: 'illegal-command' };

	if (actor.kind !== 'gm') {
		const rejection: SessionRejection = { code: 'not-authorized', message: 'only the GM may recover a session' };
		await persistLifecycleRejection(options.dbContext, {
			sessionId: options.sessionId,
			commandId,
			actorUserId: options.actorUserId,
			commandType: 'recover-session',
			expectedVersion: summary.version,
			rejection,
			now
		});
		return { ok: false, code: 'not-authorized' };
	}

	if (summary.status !== 'frozen') {
		const rejection: SessionRejection = { code: 'illegal-command', message: `session is ${summary.status}, not frozen` };
		await persistLifecycleRejection(options.dbContext, {
			sessionId: options.sessionId,
			commandId,
			actorUserId: options.actorUserId,
			commandType: 'recover-session',
			expectedVersion: summary.version,
			rejection,
			now
		});
		return { ok: false, code: 'illegal-command' };
	}

	if (options.expectedVersion !== undefined && options.expectedVersion !== summary.version) {
		const rejection: SessionRejection = {
			code: 'stale-structure',
			message: `expected version ${options.expectedVersion} does not match current version ${summary.version}`
		};
		await persistLifecycleRejection(options.dbContext, {
			sessionId: options.sessionId,
			commandId,
			actorUserId: options.actorUserId,
			commandType: 'recover-session',
			expectedVersion: summary.version,
			rejection,
			now
		});
		return { ok: false, code: 'stale-structure' };
	}

	const statements = buildRecoverStatements({
		commandRowId: nanoid(),
		commandId,
		sessionId: options.sessionId,
		campaignId: options.campaignId,
		actorUserId: options.actorUserId,
		expectedVersion: summary.version,
		now
	});

	try {
		await runAtomic(options.dbContext, statements);
		return { ok: true };
	} catch (cause) {
		if (!isUniqueConstraintError(cause)) throw cause;
		const rejection: SessionRejection = { code: 'stale-structure', message: 'the session advanced past the expected version' };
		await persistLifecycleRejection(options.dbContext, {
			sessionId: options.sessionId,
			commandId,
			actorUserId: options.actorUserId,
			commandType: 'recover-session',
			expectedVersion: summary.version,
			rejection,
			now
		});
		return { ok: false, code: 'stale-structure' };
	}
}

// ---------------------------------------------------------------------------
// End
// ---------------------------------------------------------------------------

export interface EndSessionOptions {
	dbContext: AppDbContext;
	campaignId: string;
	sessionId: string;
	actorUserId: string;
	expectedVersion?: number;
	now?: Date;
}

export type EndSessionResult = { ok: true; publicHistoryChecksum: string } | { ok: false; code: LifecycleRejectionCode };

/**
 * End cleanup (amendment 9): stamps `finalPublicStateJson` (the GM-visible
 * public projection, canonically serialized), hashes every ordered public
 * event plus that final state into `publicHistoryChecksum` — documented as
 * corruption detection only, never an integrity *guarantee* a client should
 * trust for anything security-sensitive — then deletes every private row and
 * secret payload and flips status to `'ended'`, all atomically, behind the
 * same version claim `buildEndSessionStatements` now takes (the critical
 * fix — see this module's file header). The snapshot/checksum are computed
 * from `loadSessionForReduce`'s read and submitted as part of the *same*
 * claimed batch, so they can never commit against a version other than the
 * one they were actually computed from: a losing claim rolls back the whole
 * batch, checksum included, rather than persisting something stale.
 */
export async function endSession(options: EndSessionOptions): Promise<EndSessionResult> {
	const db = options.dbContext.db as unknown as AppDb;
	const now = options.now ?? new Date();
	const commandId = nanoid();

	const actor = await resolveSessionActor(db, options.campaignId, options.actorUserId);
	if (!actor) return { ok: false, code: 'not-authorized' };

	const summary = await loadSessionSummary(db, options.sessionId);
	if (!summary || summary.campaignId !== options.campaignId) return { ok: false, code: 'illegal-command' };

	if (actor.kind !== 'gm') {
		const rejection: SessionRejection = { code: 'not-authorized', message: 'only the GM may end a session' };
		await persistLifecycleRejection(options.dbContext, {
			sessionId: options.sessionId,
			commandId,
			actorUserId: options.actorUserId,
			commandType: 'end-session',
			expectedVersion: summary.version,
			rejection,
			now
		});
		return { ok: false, code: 'not-authorized' };
	}

	if (summary.status === 'ended') {
		const rejection: SessionRejection = { code: 'illegal-command', message: 'session is already ended' };
		await persistLifecycleRejection(options.dbContext, {
			sessionId: options.sessionId,
			commandId,
			actorUserId: options.actorUserId,
			commandType: 'end-session',
			expectedVersion: summary.version,
			rejection,
			now
		});
		return { ok: false, code: 'illegal-command' };
	}

	if (options.expectedVersion !== undefined && options.expectedVersion !== summary.version) {
		const rejection: SessionRejection = {
			code: 'stale-structure',
			message: `expected version ${options.expectedVersion} does not match current version ${summary.version}`
		};
		await persistLifecycleRejection(options.dbContext, {
			sessionId: options.sessionId,
			commandId,
			actorUserId: options.actorUserId,
			commandType: 'end-session',
			expectedVersion: summary.version,
			rejection,
			now
		});
		return { ok: false, code: 'stale-structure' };
	}

	// Fragments are still intact (status isn't 'ended'), so this full load
	// succeeds; its version is the freshest available and is what the claim
	// below actually commits against.
	const loaded = await loadSessionForReduce(db, options.sessionId);

	const catalog = toSessionEngineRuntime(loaded.runtimeContent).catalog;
	const finalPublicProjection = projectForActor(loaded.engineState, actor, catalog).public;
	const finalPublicStateJson = canonicalJsonStringify(finalPublicProjection);

	const publicEventRows = await db
		.select({ id: campaignEvents.id, kind: campaignEvents.kind, publicPayloadJson: campaignEvents.publicPayloadJson })
		.from(campaignEvents)
		.where(eq(campaignEvents.sessionId, options.sessionId));
	const orderedPublicEvents = publicEventRows
		.slice()
		.sort((a, b) => a.id - b.id)
		.map((row) => ({ id: row.id, kind: row.kind, publicPayload: JSON.parse(row.publicPayloadJson) as unknown }));

	const publicHistoryChecksum = canonicalDigest({ events: orderedPublicEvents, finalPublicState: finalPublicProjection });

	const statements = buildEndSessionStatements({
		commandRowId: nanoid(),
		commandId,
		sessionId: options.sessionId,
		campaignId: options.campaignId,
		actorUserId: options.actorUserId,
		expectedVersion: loaded.currentVersion,
		finalPublicStateJson,
		publicHistoryChecksum,
		now
	});

	try {
		await runAtomic(options.dbContext, statements);
		return { ok: true, publicHistoryChecksum };
	} catch (cause) {
		if (!isUniqueConstraintError(cause)) throw cause;
		const rejection: SessionRejection = { code: 'stale-structure', message: 'the session advanced past the expected version' };
		await persistLifecycleRejection(options.dbContext, {
			sessionId: options.sessionId,
			commandId,
			actorUserId: options.actorUserId,
			commandType: 'end-session',
			expectedVersion: loaded.currentVersion,
			rejection,
			now
		});
		return { ok: false, code: 'stale-structure' };
	}
}
