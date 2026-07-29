import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/d1';
import { Miniflare } from 'miniflare';
import * as schema from '$lib/server/db/schema';
import type { AppDb } from '$lib/server/db';
import type { AppDbContext } from '$lib/server/db/atomic';
import {
	currentRequestTiming,
	instrumentD1,
	runWithRequestTiming
} from '$lib/server/observability/request-timing';
import { ensureUser } from '$lib/server/auth';
import { loadSessionForReduce } from '$lib/server/session/repository';
import { loadTableProjectionsForActor } from '$lib/server/session/table-projections';
import { executeCommand } from '$lib/server/session/command-service';
import { startSession } from '$lib/server/session/lifecycle';
import type { SessionCommand, SessionCommandEnvelope } from '$lib/types/session';

/**
 * Round-trip budgets (2026-07-28, following the instrumented gate run).
 *
 * The 17:49 UTC gate run established that latency on this application is bound
 * by the NUMBER of sequential D1 round trips, not by the wire and not by D1
 * throughput: 94% of a poll and 96.5% of a command was time inside D1 calls, at
 * ~80ms each, with commands achieving 1.00x concurrency — every round trip on
 * the critical path, in sequence. See docs/operations/campaign-capacity.md.
 *
 * These tests exist because a round-trip count is invisible to every other test
 * in this suite. A refactor that adds one innocuous `await db.select()` inside a
 * helper costs ~80ms on every affected request in production and no existing
 * test would notice. These assert the budget directly.
 *
 * They are deliberately EXACT (`toBe`, not `toBeLessThanOrEqual`). A budget that
 * silently absorbs a regression until it crosses a threshold is not a budget.
 * If a change legitimately alters a count, update the number here and say why in
 * the commit — that is the review checkpoint these tests are for.
 *
 * Miniflare rather than better-sqlite3 because `instrumentD1` only wraps D1 —
 * on purpose, since better-sqlite3's synchronous in-process calls are not
 * network round trips and counting them would invite false comparisons.
 */

const GM = 'gm-a';

describe('D1 round-trip budgets', () => {
	let miniflare: Miniflare;
	let raw: D1Database;
	let instrumented: D1Database;
	let db: AppDb;
	let ctx: AppDbContext;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: 'export default { fetch() { return new Response("ok") } }',
			d1Databases: ['DB']
		});
		raw = await miniflare.getD1Database('DB');
		await applyMigrations(raw);

		instrumented = instrumentD1(raw);
		db = drizzle(instrumented, { schema }) as unknown as AppDb;
		ctx = { kind: 'd1', db: db as never, raw: instrumented };
	});

	afterAll(async () => {
		await miniflare.dispose();
	});

	beforeEach(async () => {
		await resetFixture(raw);
		const started = await startSession({
			dbContext: ctx,
			campaignId: 'campaign-a',
			actorUserId: GM,
			sessionId: 'session-a',
			shuffleSeed: 'deterministic-seed',
			now: new Date(1_000)
		});
		if (!started.ok) throw new Error(`fixture session failed to start: ${started.code}`);
	});

	/** Runs `fn` in a fresh timing scope and returns the round trips it cost. */
	async function roundTrips(fn: () => Promise<unknown>): Promise<number> {
		return runWithRequestTiming(async () => {
			await fn();
			return currentRequestTiming()?.d1Calls ?? -1;
		});
	}

	it('authenticates a request without spending a database round trip', async () => {
		const event = {
			locals: { auth: async () => ({ user: { id: GM } }) },
			platform: { env: { DB: raw } }
		} as unknown as Parameters<typeof ensureUser>[0];

		const trips = await roundTrips(() => ensureUser(event));

		// Was 1, and that read duplicated one the Auth.js `jwt` callback had
		// already done for the same row in the same request. Paid by EVERY
		// authenticated request, including the ~80% of polls that answer `204`.
		//
		// `locals.auth` is stubbed here, so this measures `ensureUser`'s OWN cost
		// in isolation. In a real request `getUserId` still triggers one `users`
		// read inside the `jwt` callback, because `@auth/sveltekit` does not
		// memoise `locals.auth()` — so the per-request saving is one duplicate
		// read, not the whole auth cost. See "Remaining opportunity: memoise the
		// session per request" in docs/operations/campaign-capacity.md.
		//
		// Safe to drop only because the `jwt` callback rejects a token whose
		// durable user is gone before `locals.auth()` ever returns an id — pinned
		// by "clears a current JWT after its durable user is deleted" in
		// tests/unit/auth-lifecycle.test.ts. That test and this one are a pair; if
		// that check is ever removed from the callback, this saving is unsafe.
		expect(trips).toBe(0);
	});

	it('loads a session for reduce within its round-trip budget', async () => {
		const trips = await roundTrips(() => loadSessionForReduce(db, 'session-a'));

		// Was 5. Four of the five reads are keyed only by `sessionId` and so do
		// not depend on each other; a D1 `batch()` is ONE round trip however many
		// statements it carries. Only the campaign-owner read genuinely depends on
		// an earlier result (it needs the session's `campaignId`).
		expect(trips).toBe(2);
	});

	it('builds an actor projection within its round-trip budget', async () => {
		const trips = await roundTrips(() =>
			loadTableProjectionsForActor(db, 'session-a', 'campaign-a', { kind: 'gm', userId: GM })
		);

		// 10 originally, then 7 after the session load was batched, now 4:
		//
		//   -1  `loadSessionSummary` read `play_sessions` and `loadSessionForReduce`
		//       then read the same row again. The ownership check that summary
		//       existed for now happens inside the load itself.
		//   -2  the guided-test, Camp and finite slices each called
		//       `loadSessionActorFacts(db, campaignId)` — literally the same
		//       function, same argument, three times.
		//
		// What remains: the batched fragment load, the campaign-owner read it
		// depends on, the campaign cursor, and one actor-facts read.
		expect(trips).toBe(4);
	});

	it('reuses the caller-supplied cursor instead of re-reading it', async () => {
		const trips = await roundTrips(() =>
			loadTableProjectionsForActor(db, 'session-a', 'campaign-a', { kind: 'gm', userId: GM }, 7)
		);

		// One fewer than the read-it-yourself path above: this is what `/sync`
		// takes on a changed poll, since it always already holds the cursor.
		expect(trips).toBe(3);
	});

	it('still hides an out-of-campaign session behind not-found', async () => {
		// The dropped `loadSessionSummary` existed to make this ordering explicit:
		// decide ownership BEFORE parsing fragments, so a caller outside the
		// campaign gets a flat `not-found` and never an `unloadable` that would
		// confirm the session id exists somewhere. Removing the read must not
		// remove the property.
		const result = await loadTableProjectionsForActor(db, 'session-a', 'other-campaign', {
			kind: 'gm',
			userId: GM
		});

		expect(result.loadFailure).toBe('not-found');
	});

	it('accepts a command within its round-trip budget', async () => {
		const outcome = await runWithRequestTiming(async () => {
			const result = await executeCommand({
				dbContext: ctx,
				campaignId: 'campaign-a',
				sessionId: 'session-a',
				actorUserId: GM,
				envelope: endRound('command-1')
			});
			return { result, trips: currentRequestTiming()?.d1Calls ?? -1 };
		});

		// A REJECTED command is materially cheaper than an accepted one — it never
		// reduces, never commits and never builds a fresh projection. Asserting the
		// outcome keeps a broken fixture from quietly passing the budget: an
		// earlier draft of this test measured 10 trips because the envelope was
		// missing `expectedStructuralVersion` and every command was rejected.
		expect(outcome.result.outcome).toMatchObject({ ok: true });

		// Was 16: -3 from the batched pre-commit load, -5 from not re-loading the
		// whole session after the commit purely to build the response, and -1 from
		// reusing the cursor the post-commit hint already read.
		expect(outcome.trips).toBe(7);
	});
});

function endRound(commandId: string): SessionCommandEnvelope<SessionCommand> {
	return {
		commandId,
		observedSessionVersion: 1,
		// `end-round` is a structural intent, so this is a hard precondition, not
		// an advisory hint. Omitting it yields `stale-structure`.
		expectedStructuralVersion: 1,
		command: { type: 'end-round' }
	};
}

async function resetFixture(d1: D1Database): Promise<void> {
	await d1.batch([
		d1.prepare('DELETE FROM campaign_events'),
		d1.prepare('DELETE FROM session_commands'),
		d1.prepare('DELETE FROM session_private_states'),
		d1.prepare('DELETE FROM session_server_states'),
		d1.prepare('DELETE FROM play_sessions'),
		d1.prepare('DELETE FROM campaign_members'),
		d1.prepare('DELETE FROM campaigns'),
		d1.prepare('DELETE FROM users')
	]);
	await d1.batch([
		d1.prepare('INSERT INTO users (id) VALUES (?), (?), (?)').bind(GM, 'player-a', 'player-b'),
		d1
			.prepare(
				'INSERT INTO campaigns (id, owner_user_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
			)
			.bind('campaign-a', GM, 'The Lantern Guild', '', 100, 100),
		d1
			.prepare(
				'INSERT INTO campaign_members (id, campaign_id, user_id, joined_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?)'
			)
			.bind('member-a', 'campaign-a', 'player-a', 100, 'member-b', 'campaign-a', 'player-b', 100)
	]);
}

async function applyMigrations(d1: D1Database): Promise<void> {
	const directory = join(process.cwd(), 'src/lib/server/db/migrations');
	for (const filename of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
		const statements = readFileSync(join(directory, filename), 'utf8')
			.split('--> statement-breakpoint')
			.map((entry) => entry.trim())
			.filter(Boolean);
		for (const entry of statements) await d1.prepare(entry).run();
	}
}
