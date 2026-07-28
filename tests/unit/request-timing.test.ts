import { describe, expect, it } from 'vitest';
import {
	currentRequestTiming,
	formatServerTiming,
	instrumentD1,
	runWithRequestTiming
} from '$lib/server/observability/request-timing';

/**
 * Increment 5 Task 4 follow-up — the server-side half of the capacity gate's
 * measurement.
 *
 * Both 30-minute gate runs on 2026-07-28 ended at "we cannot tell whether it is
 * the network or D1", because every number either run produced was
 * client-observed wall clock. This module exists so the next run can subtract
 * the wire. See docs/operations/campaign-capacity.md, "What the next run must
 * measure".
 *
 * The behaviour worth testing is narrow but load-bearing:
 *
 * 1. Attribution must be per request. The D1 binding is cached per isolate
 *    (`d1Contexts` in `db/index.ts`) and a Worker isolate serves concurrent
 *    requests, so a module-level counter would blend them. That is the whole
 *    reason for `AsyncLocalStorage`, and `interleaves` below is the test that
 *    would fail if someone "simplified" it back to a plain variable.
 * 2. The wrapper must be transparent. Drizzle's D1 driver calls methods this
 *    module has never heard of; anything unrecognised has to pass through
 *    untouched or every query in the application breaks.
 * 3. `batch()` must hand the REAL statements to the real binding. Wrapped
 *    statements are proxies, and the Workers runtime will not accept a proxy
 *    where it expects a `D1PreparedStatement`.
 */

// ---------------------------------------------------------------------------
// A fake D1 binding whose clock only moves when a call is made, mirroring the
// Workers runtime's own behaviour (`Date.now()` advances on I/O, not on CPU).
// ---------------------------------------------------------------------------

interface FakeD1Options {
	/** Milliseconds each round trip should appear to take. */
	costMs?: number;
}

function createFakeD1(options: FakeD1Options = {}) {
	const costMs = options.costMs ?? 10;
	let clock = 1000;
	const batchCalls: unknown[][] = [];
	const prepared: unknown[] = [];

	const now = () => clock;

	function makeStatement(sql: string, bound: readonly unknown[] = []) {
		const statement = {
			sql,
			bound,
			isRealStatement: true,
			bind: (...values: unknown[]) => makeStatement(sql, values),
			first: async () => {
				clock += costMs;
				return { sql };
			},
			all: async () => {
				clock += costMs;
				return { results: [{ sql }], success: true };
			},
			run: async () => {
				clock += costMs;
				return { success: true };
			},
			raw: async () => {
				clock += costMs;
				return [[sql]];
			},
			/** Not wrapped by `instrumentD1` — proves pass-through. */
			describeForTest: () => `statement:${sql}`
		};
		prepared.push(statement);
		return statement;
	}

	const database = {
		prepare: (sql: string) => makeStatement(sql),
		batch: async (statements: unknown[]) => {
			batchCalls.push(statements);
			clock += costMs;
			return statements.map(() => ({ success: true }));
		},
		exec: async (sql: string) => {
			clock += costMs;
			return { count: 1, duration: costMs, sql };
		},
		/** Not wrapped by `instrumentD1` — proves pass-through. */
		dump: async () => new ArrayBuffer(0),
		flavour: 'fake-d1'
	};

	return { database, now, batchCalls, prepared, get clock() { return clock; } };
}

function instrumentFake(fake: ReturnType<typeof createFakeD1>) {
	return instrumentD1(fake.database as unknown as D1Database, { now: fake.now }) as unknown as {
		prepare: (sql: string) => {
			bind: (...values: unknown[]) => Record<string, unknown> & { all: () => Promise<unknown> };
			all: () => Promise<unknown>;
			first: () => Promise<unknown>;
			run: () => Promise<unknown>;
			describeForTest: () => string;
		};
		batch: (statements: unknown[]) => Promise<unknown>;
		exec: (sql: string) => Promise<unknown>;
		dump: () => Promise<ArrayBuffer>;
		flavour: string;
	};
}

describe('request timing scope', () => {
	it('reports no timing outside a request', () => {
		expect(currentRequestTiming()).toBeNull();
	});

	it('starts a request with a zeroed accumulator', async () => {
		const seen = await runWithRequestTiming(async () => currentRequestTiming());
		expect(seen).toEqual({ d1Calls: 0, d1Statements: 0, d1DurationMs: 0 });
	});

	it('hands the same accumulator to the callback and to currentRequestTiming', async () => {
		await runWithRequestTiming(async (timing) => {
			expect(currentRequestTiming()).toBe(timing);
		});
	});

	it('does not leak the accumulator out of the scope', async () => {
		await runWithRequestTiming(async () => currentRequestTiming());
		expect(currentRequestTiming()).toBeNull();
	});
});

describe('instrumented D1 binding', () => {
	it('counts a prepare/bind/all chain as one round trip', async () => {
		const fake = createFakeD1({ costMs: 12 });
		const db = instrumentFake(fake);

		const timing = await runWithRequestTiming(async () => {
			await db.prepare('SELECT 1').bind(1).all();
			return currentRequestTiming();
		});

		expect(timing).toEqual({ d1Calls: 1, d1Statements: 1, d1DurationMs: 12 });
	});

	it('accumulates every statement kind', async () => {
		const fake = createFakeD1({ costMs: 5 });
		const db = instrumentFake(fake);

		const timing = await runWithRequestTiming(async () => {
			await db.prepare('a').all();
			await db.prepare('b').first();
			await db.prepare('c').run();
			await db.exec('d');
			return currentRequestTiming();
		});

		expect(timing?.d1Calls).toBe(4);
		expect(timing?.d1DurationMs).toBe(20);
	});

	it('counts a batch as one round trip carrying many statements', async () => {
		const fake = createFakeD1({ costMs: 30 });
		const db = instrumentFake(fake);

		const timing = await runWithRequestTiming(async () => {
			await db.batch([
				db.prepare('one').bind(1),
				db.prepare('two').bind(2),
				db.prepare('three').bind(3)
			]);
			return currentRequestTiming();
		});

		// One network round trip, three statements inside it. Conflating the two
		// would make the round-trip-count hypothesis untestable, which is the
		// only reason this module exists.
		expect(timing).toEqual({ d1Calls: 1, d1Statements: 3, d1DurationMs: 30 });
	});

	it('unwraps proxied statements before handing them to the real batch', async () => {
		const fake = createFakeD1();
		const db = instrumentFake(fake);

		await runWithRequestTiming(async () => {
			await db.batch([db.prepare('one').bind(1), db.prepare('two').bind(2)]);
		});

		expect(fake.batchCalls).toHaveLength(1);
		for (const statement of fake.batchCalls[0]) {
			// The Workers runtime rejects a Proxy where it expects a real
			// D1PreparedStatement, so this is a correctness requirement and not a
			// tidiness one.
			expect(fake.prepared).toContain(statement);
		}
	});

	it('passes unrecognised members through untouched', async () => {
		const fake = createFakeD1();
		const db = instrumentFake(fake);

		expect(db.flavour).toBe('fake-d1');
		expect(await db.dump()).toBeInstanceOf(ArrayBuffer);
		expect(db.prepare('x').describeForTest()).toBe('statement:x');
	});

	it('records nothing, and throws nothing, outside a request scope', async () => {
		const fake = createFakeD1();
		const db = instrumentFake(fake);

		await expect(db.prepare('SELECT 1').all()).resolves.toBeDefined();
		expect(currentRequestTiming()).toBeNull();
	});

	it('still records the round trip when the query rejects', async () => {
		const failing = {
			prepare: () => ({
				bind: () => failing.prepare(),
				all: async () => {
					throw new Error('D1_ERROR: UNIQUE constraint failed');
				}
			})
		};
		let ticks = 0;
		const db = instrumentD1(failing as unknown as D1Database, {
			now: () => (ticks += 7)
		}) as unknown as { prepare: () => { all: () => Promise<unknown> } };

		const timing = await runWithRequestTiming(async () => {
			await expect(db.prepare().all()).rejects.toThrow('UNIQUE constraint failed');
			return currentRequestTiming();
		});

		// `command-service.ts` treats a UNIQUE violation as an ordinary lost-race
		// outcome and retries. A retry that costs a round trip but records none
		// would understate exactly the requests we most need to understand.
		expect(timing?.d1Calls).toBe(1);
		expect(timing?.d1DurationMs).toBe(7);
	});

	it('attributes concurrent requests to their own accumulators', async () => {
		const fake = createFakeD1({ costMs: 4 });
		const db = instrumentFake(fake);

		const one = runWithRequestTiming(async () => {
			await db.prepare('a').all();
			await db.prepare('b').all();
			await db.prepare('c').all();
			return currentRequestTiming();
		});
		const two = runWithRequestTiming(async () => {
			await db.prepare('z').all();
			return currentRequestTiming();
		});

		const [first, second] = await Promise.all([one, two]);

		expect(first?.d1Calls).toBe(3);
		expect(second?.d1Calls).toBe(1);
	});
});

describe('Server-Timing formatting', () => {
	it('emits the server total, the D1 total and the round-trip count', () => {
		const header = formatServerTiming({
			serverMs: 42.5,
			timing: { d1Calls: 6, d1Statements: 9, d1DurationMs: 31 }
		});

		expect(header).toBe('srv;dur=42.5, d1;dur=31;desc="n=6 stmts=9"');
	});

	it('omits the D1 metric entirely when the request touched no database', () => {
		const header = formatServerTiming({
			serverMs: 3,
			timing: { d1Calls: 0, d1Statements: 0, d1DurationMs: 0 }
		});

		expect(header).toBe('srv;dur=3');
	});

	it('tolerates a missing accumulator', () => {
		expect(formatServerTiming({ serverMs: 8, timing: null })).toBe('srv;dur=8');
	});

	it('never emits a quote that would break the header grammar', () => {
		const header = formatServerTiming({
			serverMs: 1,
			timing: { d1Calls: 1, d1Statements: 1, d1DurationMs: 1 }
		});
		expect(header.match(/"/g)).toHaveLength(2);
	});
});
