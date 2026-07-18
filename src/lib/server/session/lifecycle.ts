/**
 * Session lifecycle: start, freeze-on-failure, GM recovery, and end (Task 5
 * brief Step 5 + task-title "recovery"). Freeze/recover/end are GM-only,
 * single-attempt, and — when a caller supplies `expectedVersion` — hard
 * reject with `stale-structure` on a mismatch, matching the structural
 * pattern `command-service.ts` uses for in-band `SessionCommand`s (amendment
 * 8: "GM lifecycle freeze/recover/end are structural commands through the
 * same service"). They are not literal `SessionCommand`s though (there's no
 * `'freeze'`/`'recover'`/`'end-session'` entry in that frozen union), so they
 * don't run through `executeCommand`'s envelope/idempotency machinery — a
 * status-guarded atomic write is enough here: these are low-frequency GM-only
 * actions, and a benign race (two concurrent recovers, say) just produces a
 * harmless duplicate audit event, never a correctness issue (see
 * `repository.ts`'s `buildFreezeStatements`/`buildRecoverStatements` doc
 * comments).
 */

import { randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';
import { and, eq, inArray } from 'drizzle-orm';
import type { AppDb } from '$lib/server/db';
import { runAtomic, type AppDbContext } from '$lib/server/db/atomic';
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
	buildStartSessionStatements,
	listActiveCampaignMemberUserIds,
	loadSessionForReduce,
	loadSessionSummary,
	resolveSessionActor,
	standardPrivateZonesForMember,
	standardPublicZones
} from './repository';
import type { SessionEngineStateV1 } from '$lib/types/session';

export type LifecycleRejectionCode = 'not-authorized' | 'illegal-command' | 'stale-structure';

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
 * atomically (circular-FK insert order — amendment 4).
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
	now?: Date;
}

export async function freezeSessionForFailure(dbContext: AppDbContext, input: FreezeForFailureInput): Promise<void> {
	await runAtomic(
		dbContext,
		buildFreezeStatements({ sessionId: input.sessionId, campaignId: input.campaignId, reason: input.reason, now: input.now ?? new Date() })
	);
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

	const actor = await resolveSessionActor(db, options.campaignId, options.actorUserId);
	if (!actor || actor.kind !== 'gm') return { ok: false, code: 'not-authorized' };

	const summary = await loadSessionSummary(db, options.sessionId);
	if (!summary || summary.campaignId !== options.campaignId) return { ok: false, code: 'illegal-command' };
	if (summary.status !== 'frozen') return { ok: false, code: 'illegal-command' };
	if (options.expectedVersion !== undefined && options.expectedVersion !== summary.version) {
		return { ok: false, code: 'stale-structure' };
	}

	await runAtomic(
		options.dbContext,
		buildRecoverStatements({
			sessionId: options.sessionId,
			campaignId: options.campaignId,
			actorUserId: options.actorUserId,
			now: options.now ?? new Date()
		})
	);
	return { ok: true };
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
 * secret payload and flips status to `'ended'`, all atomically.
 */
export async function endSession(options: EndSessionOptions): Promise<EndSessionResult> {
	const db = options.dbContext.db as unknown as AppDb;

	const actor = await resolveSessionActor(db, options.campaignId, options.actorUserId);
	if (!actor || actor.kind !== 'gm') return { ok: false, code: 'not-authorized' };

	const loaded = await loadSessionForReduce(db, options.sessionId).catch(() => null);
	if (!loaded || loaded.campaignId !== options.campaignId) return { ok: false, code: 'illegal-command' };
	if (loaded.status === 'ended') return { ok: false, code: 'illegal-command' };
	if (options.expectedVersion !== undefined && options.expectedVersion !== loaded.currentVersion) {
		return { ok: false, code: 'stale-structure' };
	}

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

	await runAtomic(
		options.dbContext,
		buildEndSessionStatements({
			sessionId: options.sessionId,
			campaignId: options.campaignId,
			actorUserId: options.actorUserId,
			finalPublicStateJson,
			publicHistoryChecksum,
			now: options.now ?? new Date()
		})
	);

	return { ok: true, publicHistoryChecksum };
}
