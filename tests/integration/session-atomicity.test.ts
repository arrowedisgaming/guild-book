import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Miniflare } from 'miniflare';
import { nanoid } from 'nanoid';
import * as schema from '$lib/server/db/schema';
import type { AppDb } from '$lib/server/db';
import type { AppDbContext, AtomicStatement } from '$lib/server/db/atomic';
import { runAtomic } from '$lib/server/db/atomic';
import {
	buildAcceptedCommandStatements,
	buildEndSessionStatements,
	buildStartSessionStatements,
	loadSessionForReduce,
	standardPrivateZonesForMember,
	standardPublicZones
} from '$lib/server/session/repository';
import { startSession } from '$lib/server/session/lifecycle';
import { executeCommand } from '$lib/server/session/command-service';
import { reduceSession, type ReduceContext } from '$lib/engine/session/reducer';
import { toSessionEngineRuntime, compileSessionRuntimeContent } from '$lib/server/content/session-runtime';
import { getContentPack, getTarotProcedures } from '$lib/server/content/loader';
import { buildMajorDeck, buildPlayerDeck, shuffleDeck } from '$lib/engine/tarot-deck';
import { makeRng } from '$lib/engine/rng';
import type { SessionActor, SessionCommand, SessionEngineStateV1 } from '$lib/types/session';

const BROKEN_STATEMENT: AtomicStatement = { sql: 'INSERT INTO __no_such_table__ (x) VALUES (1)', params: [] };

/**
 * Failure-injection matrix (brief Step 6): for every statement index in a
 * real command/lifecycle atomic write, corrupt that one statement so it
 * throws, run the whole batch, and assert the DB is byte-for-byte unchanged
 * — no command claim, no fragment update, no event, no secret survives a
 * partial write. Run against SQLite for the full matrix; a first/middle/last
 * subset also runs against local D1 (amendment 6) in the second `describe`
 * block below.
 */
describe('session atomicity — SQLite failure-injection matrix', () => {
	let sqlite: Database.Database;
	let ctx: AppDbContext;

	beforeEach(() => {
		sqlite = new Database(':memory:');
		sqlite.pragma('foreign_keys = ON');
		applyMigrations(sqlite);
		seedFoundation(sqlite);
		ctx = { kind: 'sqlite', db: drizzle(sqlite, { schema }), raw: sqlite };
	});

	afterEach(() => sqlite.close());

	it('rolls back the whole start-session batch at every statement index', async () => {
		const pack = getContentPack();
		const runtimeContent = compileSessionRuntimeContent({ pack, proceduresFile: getTarotProcedures() });
		const rng = makeRng('atomicity-start-seed');
		const initialState: SessionEngineStateV1 = {
			schemaVersion: 1,
			sessionId: 'session-start-atomic',
			version: 1,
			phase: 'crawl',
			procedure: null,
			majorDraw: shuffleDeck(buildMajorDeck(pack.tarot), rng).map((c) => c.id),
			majorDiscard: [],
			playerDraw: shuffleDeck(buildPlayerDeck(pack.tarot), rng).map((c) => c.id),
			playerDiscard: [],
			gmHand: [],
			privateZones: ['player-a', 'player-b'].flatMap(standardPrivateZonesForMember),
			publicZones: standardPublicZones(),
			pendingZones: [],
			reshuffleAtBoundary: { major: false, player: false }
		};
		const statements = buildStartSessionStatements({
			sessionId: 'session-start-atomic',
			campaignId: 'campaign-a',
			sequence: 1,
			contentPackId: runtimeContent.contentPackId,
			contentPackVersion: runtimeContent.contentPackVersion,
			contentDigest: runtimeContent.contentDigest,
			runtimeContent,
			initialState,
			shuffleSeed: 'atomicity-start-seed',
			gmUserId: 'gm-a',
			memberUserIds: ['player-a', 'player-b'],
			startedByUserId: 'gm-a',
			now: new Date(1_000),
			idFactory: () => nanoid()
		});
		expect(statements.length).toBeGreaterThan(5);

		for (let i = 0; i < statements.length; i++) {
			await expect(runAtomic(ctx, corruptAt(statements, i))).rejects.toThrow();
			expect(sqlite.prepare('SELECT count(*) AS n FROM play_sessions').get()).toEqual({ n: 0 });
			expect(sqlite.prepare('SELECT count(*) AS n FROM session_runtime_contents').get()).toEqual({ n: 0 });
			expect(sqlite.prepare('SELECT count(*) AS n FROM session_server_states').get()).toEqual({ n: 0 });
			expect(sqlite.prepare('SELECT count(*) AS n FROM session_private_states').get()).toEqual({ n: 0 });
			expect(sqlite.prepare('SELECT count(*) AS n FROM campaign_events').get()).toEqual({ n: 0 });
		}

		// Sanity: the same (uncorrupted) statement list actually succeeds.
		await runAtomic(ctx, statements);
		expect(sqlite.prepare('SELECT count(*) AS n FROM play_sessions').get()).toEqual({ n: 1 });
	});

	it('rolls back the whole accepted-command batch at every statement index', async () => {
		const started = await startSession({ dbContext: ctx, campaignId: 'campaign-a', actorUserId: 'gm-a', sessionId: 'session-a', shuffleSeed: 'cmd-seed', now: new Date(1_000) });
		if (!started.ok) throw new Error('fixture session failed to start');

		const db = ctx.db as unknown as AppDb;
		const actor: SessionActor = { kind: 'player', userId: 'player-a' };
		const loaded = await loadSessionForReduce(db, 'session-a');
		const context: ReduceContext = { actor, runtime: toSessionEngineRuntime(loaded.runtimeContent), rng: makeRng('reduce-seed') };
		const command: SessionCommand = { type: 'draw', deck: 'player', destinationZoneId: 'hand:player-a', count: 1 };
		const reduceResult = reduceSession(loaded.engineState, command, context);
		if (!reduceResult.ok) throw new Error('fixture reduce unexpectedly rejected');
		const nextState = { ...reduceResult.state, version: loaded.currentVersion + 1 };

		const statements = buildAcceptedCommandStatements({
			commandRowId: nanoid(),
			sessionId: 'session-a',
			campaignId: 'campaign-a',
			commandId: 'draw-1',
			actorUserId: 'player-a',
			requestHash: 'test-hash',
			commandType: 'draw',
			clientObservedVersion: 1,
			structuralPreconditionVersion: null,
			expectedVersion: loaded.currentVersion,
			nextState,
			events: reduceResult.events,
			shuffleSeed: loaded.shuffleSeed,
			gmUserId: loaded.gmUserId,
			recipientUserIds: loaded.recipientUserIds,
			now: new Date(2_000),
			idFactory: () => nanoid()
		});
		// A draw into a private zone emits a private payload -> at least a
		// claim, a play_sessions update, a server-state update, 3 private-state
		// updates, an event, and a secret: >= 7 statements.
		expect(statements.length).toBeGreaterThanOrEqual(7);

		// `startSession` already recorded its own 'session-started' event —
		// the baseline every corrupted attempt below must not grow past.
		const baselineEventCount = (sqlite.prepare("SELECT count(*) AS n FROM campaign_events WHERE session_id = 'session-a'").get() as { n: number }).n;
		const baselineSecretCount = (sqlite.prepare('SELECT count(*) AS n FROM campaign_event_secrets').get() as { n: number }).n;

		for (let i = 0; i < statements.length; i++) {
			await expect(runAtomic(ctx, corruptAt(statements, i))).rejects.toThrow();
			expect(sqlite.prepare("SELECT count(*) AS n FROM session_commands WHERE session_id = 'session-a'").get()).toEqual({ n: 0 });
			expect(sqlite.prepare("SELECT version FROM play_sessions WHERE id = 'session-a'").get()).toEqual({ version: 1 });
			expect(sqlite.prepare("SELECT session_version AS v FROM session_server_states WHERE session_id = 'session-a'").get()).toEqual({ v: 1 });
			for (const row of sqlite.prepare("SELECT session_version AS v FROM session_private_states WHERE session_id = 'session-a'").all() as Array<{ v: number }>) {
				expect(row.v).toBe(1);
			}
			expect(sqlite.prepare("SELECT count(*) AS n FROM campaign_events WHERE session_id = 'session-a'").get()).toEqual({ n: baselineEventCount });
			expect(sqlite.prepare('SELECT count(*) AS n FROM campaign_event_secrets').get()).toEqual({ n: baselineSecretCount });
		}

		await runAtomic(ctx, statements);
		expect(sqlite.prepare("SELECT version FROM play_sessions WHERE id = 'session-a'").get()).toEqual({ version: 2 });
	});

	it('rolls back the whole end-session batch at every statement index', async () => {
		const started = await startSession({ dbContext: ctx, campaignId: 'campaign-a', actorUserId: 'gm-a', sessionId: 'session-a', shuffleSeed: 'end-seed', now: new Date(1_000) });
		if (!started.ok) throw new Error('fixture session failed to start');
		await executeCommand({
			dbContext: ctx,
			campaignId: 'campaign-a',
			sessionId: 'session-a',
			actorUserId: 'player-a',
			envelope: { commandId: 'draw-1', observedSessionVersion: 1, command: { type: 'draw', deck: 'player', destinationZoneId: 'hand:player-a', count: 1 } }
		});

		const statements = buildEndSessionStatements({
			sessionId: 'session-a',
			campaignId: 'campaign-a',
			actorUserId: 'gm-a',
			finalPublicStateJson: '{"final":true}',
			publicHistoryChecksum: 'deadbeef',
			now: new Date(3_000)
		});
		expect(statements.length).toBeGreaterThanOrEqual(5);

		for (let i = 0; i < statements.length; i++) {
			await expect(runAtomic(ctx, corruptAt(statements, i))).rejects.toThrow();
			expect(sqlite.prepare("SELECT status FROM play_sessions WHERE id = 'session-a'").get()).toEqual({ status: 'active' });
			expect(sqlite.prepare("SELECT count(*) AS n FROM session_private_states WHERE session_id = 'session-a'").get()).toEqual({ n: 3 });
		}

		await runAtomic(ctx, statements);
		expect(sqlite.prepare("SELECT status FROM play_sessions WHERE id = 'session-a'").get()).toEqual({ status: 'ended' });
		expect(sqlite.prepare("SELECT count(*) AS n FROM session_private_states WHERE session_id = 'session-a'").get()).toEqual({ n: 0 });
	});
});

/** Amendment 6: representative first/middle/last failures against local D1
 * (Miniflare), mirroring `tests/integration/campaign-service-d1.test.ts`'s
 * harness. The full index-by-index matrix already ran above on SQLite. */
describe('session atomicity — D1 representative failures', () => {
	let miniflare: Miniflare;
	let d1: D1Database;
	let ctx: AppDbContext;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: 'export default { fetch() { return new Response("ok") } }',
			d1Databases: ['DB']
		});
		d1 = await miniflare.getD1Database('DB');
		await applyMigrationsD1(d1);
	});

	afterAll(async () => {
		await miniflare.dispose();
	});

	beforeEach(async () => {
		ctx = { kind: 'd1', db: drizzleD1(d1, { schema }), raw: d1 };
		await seedFoundationD1(d1);
	});

	afterEach(async () => {
		await d1.exec(`DELETE FROM campaign_events; DELETE FROM session_private_states; DELETE FROM session_server_states; DELETE FROM session_runtime_contents; DELETE FROM play_sessions; DELETE FROM campaign_members; DELETE FROM campaigns; DELETE FROM users;`);
	});

	it('rolls back the accepted-command batch on D1 at the first, a middle, and the last statement', async () => {
		const started = await startSession({ dbContext: ctx, campaignId: 'campaign-a', actorUserId: 'gm-a', sessionId: 'session-a', shuffleSeed: 'd1-seed', now: new Date(1_000) });
		if (!started.ok) throw new Error(`fixture session failed to start on D1: ${started.code}`);

		const db = ctx.db as unknown as AppDb;
		const actor: SessionActor = { kind: 'player', userId: 'player-a' };
		const loaded = await loadSessionForReduce(db, 'session-a');
		const context: ReduceContext = { actor, runtime: toSessionEngineRuntime(loaded.runtimeContent), rng: makeRng('d1-reduce-seed') };
		const command: SessionCommand = { type: 'draw', deck: 'player', destinationZoneId: 'hand:player-a', count: 1 };
		const reduceResult = reduceSession(loaded.engineState, command, context);
		if (!reduceResult.ok) throw new Error('fixture reduce unexpectedly rejected');
		const nextState = { ...reduceResult.state, version: loaded.currentVersion + 1 };

		const statements = buildAcceptedCommandStatements({
			commandRowId: nanoid(),
			sessionId: 'session-a',
			campaignId: 'campaign-a',
			commandId: 'draw-1',
			actorUserId: 'player-a',
			requestHash: 'test-hash',
			commandType: 'draw',
			clientObservedVersion: 1,
			structuralPreconditionVersion: null,
			expectedVersion: loaded.currentVersion,
			nextState,
			events: reduceResult.events,
			shuffleSeed: loaded.shuffleSeed,
			gmUserId: loaded.gmUserId,
			recipientUserIds: loaded.recipientUserIds,
			now: new Date(2_000),
			idFactory: () => nanoid()
		});

		const representativeIndices = [...new Set([0, Math.floor(statements.length / 2), statements.length - 1])];
		for (const i of representativeIndices) {
			await expect(runAtomic(ctx, corruptAt(statements, i))).rejects.toThrow();
			const versionRow = await d1.prepare("SELECT version FROM play_sessions WHERE id = 'session-a'").first<{ version: number }>();
			expect(versionRow?.version).toBe(1);
			const commandCount = await d1.prepare("SELECT count(*) AS n FROM session_commands WHERE session_id = 'session-a'").first<{ n: number }>();
			expect(commandCount?.n).toBe(0);
		}

		await runAtomic(ctx, statements);
		const finalVersion = await d1.prepare("SELECT version FROM play_sessions WHERE id = 'session-a'").first<{ version: number }>();
		expect(finalVersion?.version).toBe(2);
	});
});

function corruptAt(statements: readonly AtomicStatement[], index: number): AtomicStatement[] {
	return statements.map((statement, i) => (i === index ? BROKEN_STATEMENT : statement));
}

function applyMigrations(sqlite: Database.Database): void {
	const directory = join(process.cwd(), 'src/lib/server/db/migrations');
	for (const filename of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
		sqlite.exec(readFileSync(join(directory, filename), 'utf8'));
	}
}

function seedFoundation(sqlite: Database.Database): void {
	for (const userId of ['gm-a', 'player-a', 'player-b']) {
		sqlite.prepare('INSERT INTO users (id) VALUES (?)').run(userId);
	}
	sqlite
		.prepare('INSERT INTO campaigns (id, owner_user_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
		.run('campaign-a', 'gm-a', 'The Lantern Guild', '', 100, 100);
	sqlite
		.prepare('INSERT INTO campaign_members (id, campaign_id, user_id, joined_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?)')
		.run('member-a', 'campaign-a', 'player-a', 100, 'member-b', 'campaign-a', 'player-b', 100);
}

async function applyMigrationsD1(d1: D1Database): Promise<void> {
	const directory = join(process.cwd(), 'src/lib/server/db/migrations');
	for (const filename of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
		const statements = readFileSync(join(directory, filename), 'utf8')
			.split('--> statement-breakpoint')
			.map((stmt) => stmt.trim())
			.filter(Boolean);
		for (const stmt of statements) await d1.prepare(stmt).run();
	}
}

async function seedFoundationD1(d1: D1Database): Promise<void> {
	await d1.prepare("INSERT INTO users (id) VALUES ('gm-a'), ('player-a'), ('player-b')").run();
	await d1
		.prepare('INSERT INTO campaigns (id, owner_user_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
		.bind('campaign-a', 'gm-a', 'The Lantern Guild', '', 100, 100)
		.run();
	await d1
		.prepare('INSERT INTO campaign_members (id, campaign_id, user_id, joined_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?)')
		.bind('member-a', 'campaign-a', 'player-a', 100, 'member-b', 'campaign-a', 'player-b', 100)
		.run();
}
