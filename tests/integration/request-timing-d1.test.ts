import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { Miniflare } from 'miniflare';
import * as schema from '$lib/server/db/schema';
import { campaigns, users } from '$lib/server/db/schema';
import type { AppDb } from '$lib/server/db';
import { runAtomic, statement } from '$lib/server/db/atomic';
import {
	currentRequestTiming,
	instrumentD1,
	runWithRequestTiming
} from '$lib/server/observability/request-timing';

/**
 * Increment 5 Task 4 follow-up — `instrumentD1` against a REAL D1 binding.
 *
 * `tests/unit/request-timing.test.ts` covers the accounting against a fake, but
 * a fake cannot answer the question that actually matters here: does Drizzle's
 * D1 driver still work when the binding underneath it is a Proxy? The driver
 * reaches for members this wrapper has never heard of, and `runAtomic` hands
 * `batch()` a list of prepared statements that are themselves wrappers. Getting
 * either wrong breaks every query in the application, in production only.
 *
 * So this suite runs real Drizzle reads, real writes and a real `runAtomic`
 * batch through the instrumented binding and asserts both that they behave
 * identically AND that the round trips were counted.
 */

describe('instrumented D1 binding against Miniflare', () => {
	let miniflare: Miniflare;
	let raw: D1Database;
	let instrumented: D1Database;
	let db: AppDb;

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

		await instrumented
			.prepare('INSERT INTO users (id) VALUES (?), (?)')
			.bind('timing-owner-a', 'timing-owner-b')
			.run();
	});

	afterAll(async () => {
		await miniflare.dispose();
	});

	it('leaves ordinary Drizzle reads working and counts their round trips', async () => {
		const rows = await runWithRequestTiming(async () => {
			const found = await db.select().from(users).where(eq(users.id, 'timing-owner-a'));
			expect(found).toHaveLength(1);
			return currentRequestTiming();
		});

		expect(rows?.d1Calls).toBe(1);
		expect(rows?.d1Statements).toBe(1);
		expect(rows?.d1DurationMs).toBeGreaterThanOrEqual(0);
	});

	it('leaves ordinary Drizzle writes working', async () => {
		const timing = await runWithRequestTiming(async () => {
			await db.insert(campaigns).values({
				id: 'timing-campaign',
				ownerUserId: 'timing-owner-a',
				name: 'Timing',
				createdAt: new Date(0),
				updatedAt: new Date(0)
			});
			return currentRequestTiming();
		});

		const stored = await db.select().from(campaigns).where(eq(campaigns.id, 'timing-campaign'));
		expect(stored).toHaveLength(1);
		expect(timing?.d1Calls).toBe(1);
	});

	it('accumulates across a request that issues several queries', async () => {
		const timing = await runWithRequestTiming(async () => {
			await db.select().from(users).where(eq(users.id, 'timing-owner-a'));
			await db.select().from(users).where(eq(users.id, 'timing-owner-b'));
			await db.select().from(campaigns).where(eq(campaigns.id, 'timing-campaign'));
			return currentRequestTiming();
		});

		expect(timing?.d1Calls).toBe(3);
	});

	it('runs a real runAtomic batch through the wrapper and counts it as one round trip', async () => {
		const timing = await runWithRequestTiming(async () => {
			await runAtomic(
				{ kind: 'd1', db: db as never, raw: instrumented },
				[
					statement('INSERT INTO users (id) VALUES (?)', ['timing-batch-1']),
					statement('INSERT INTO users (id) VALUES (?)', ['timing-batch-2']),
					statement('INSERT INTO users (id) VALUES (?)', ['timing-batch-3'])
				]
			);
			return currentRequestTiming();
		});

		// The Workers runtime rejects a Proxy where a D1PreparedStatement is
		// expected, so if the unwrapping in `instrumentD1` were wrong this call
		// would have thrown rather than mis-counted.
		expect(timing).toMatchObject({ d1Calls: 1, d1Statements: 3 });

		const inserted = await raw
			.prepare("SELECT id FROM users WHERE id LIKE 'timing-batch-%' ORDER BY id")
			.all<{ id: string }>();
		expect(inserted.results.map((row) => row.id)).toEqual([
			'timing-batch-1',
			'timing-batch-2',
			'timing-batch-3'
		]);
	});

	it('still rolls a failing batch back atomically', async () => {
		await expect(
			runWithRequestTiming(async () =>
				runAtomic({ kind: 'd1', db: db as never, raw: instrumented }, [
					statement('INSERT INTO users (id) VALUES (?)', ['timing-rollback']),
					// Duplicate primary key — the whole batch must abort.
					statement('INSERT INTO users (id) VALUES (?)', ['timing-owner-a'])
				])
			)
		).rejects.toThrow();

		const survivor = await raw.prepare('SELECT id FROM users WHERE id = ?').bind('timing-rollback').first();
		expect(survivor).toBeNull();
	});

	it('counts a failed round trip rather than silently dropping it', async () => {
		const timing = await runWithRequestTiming(async () => {
			await expect(
				instrumented.prepare('INSERT INTO users (id) VALUES (?)').bind('timing-owner-a').run()
			).rejects.toThrow();
			return currentRequestTiming();
		});

		expect(timing?.d1Calls).toBe(1);
	});

	it('attributes nothing when no request scope is active', async () => {
		await instrumented.prepare('SELECT 1').all();
		expect(currentRequestTiming()).toBeNull();
	});
});

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
