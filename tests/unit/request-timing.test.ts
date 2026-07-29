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
		expect(seen).toEqual({ d1Calls: 0, d1Statements: 0, d1DurationMs: 0, d1WallMs: 0 });
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

		expect(timing).toEqual({ d1Calls: 1, d1Statements: 1, d1DurationMs: 12, d1WallMs: 12 });
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
		expect(timing).toEqual({ d1Calls: 1, d1Statements: 3, d1DurationMs: 30, d1WallMs: 30 });
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

/**
 * Regression, 2026-07-28: the first deploy of this module broke every D1 query
 * on staging (`/s/<id>` went 404 → 500) while both the unit suite above and the
 * Miniflare integration suite stayed green.
 *
 * Cause: the round-trip branch did `Reflect.get(target, prop, target)(...args)`,
 * which returns an UNBOUND method and then calls it as a bare function, so
 * `this` was `undefined`. Miniflare's `D1PreparedStatement` holds its state in
 * closures, so it did not care. workerd's is a real class whose methods need
 * `this`, so it threw "Illegal invocation" on the first `.all()`.
 *
 * The fakes above cannot catch that — they are object literals. This one is a
 * class with prototype methods that dereference `this`, which is the shape the
 * real runtime has. Miniflare is not a substitute for workerd here.
 */
/**
 * Regression, 2026-07-28 smoke run: the reported poll D1 p50 (252 ms) exceeded
 * the poll server p50 (209 ms). No single request can spend more time inside D1
 * than inside the handler that contains it, so the summed figure was counting
 * overlap twice — `sync/+server.ts` issues `campaignCursor` and
 * `findOpenSessionForCampaign` in one `Promise.all`.
 *
 * Both numbers are now kept: the SUM (right numerator for average per-round-trip
 * latency, which is what exposes Worker-to-primary distance) and the UNION
 * (the only one that may be subtracted from `srv`).
 *
 * The fakes above cannot express this — their clock only moves when a call
 * completes, so nothing ever genuinely overlaps. This one hands out unresolved
 * promises so two calls can be in flight across the same advancing clock.
 */
describe('concurrent D1 calls', () => {
	function createControllableD1() {
		let clock = 0;
		const pending: Array<() => void> = [];

		const database = {
			prepare: (sql: string) => {
				const statement: Record<string, unknown> = {
					sql,
					bind: () => statement,
					all: () =>
						new Promise((resolve) => {
							pending.push(() => resolve({ results: [], success: true }));
						})
				};
				return statement;
			}
		};

		return {
			database,
			now: () => clock,
			advance: (ms: number) => {
				clock += ms;
			},
			settleAll: () => {
				const waiting = [...pending];
				pending.length = 0;
				for (const resolve of waiting) resolve();
			}
		};
	}

	it('sums overlapping calls but counts their wall time once', async () => {
		const fake = createControllableD1();
		const db = instrumentD1(fake.database as unknown as D1Database, {
			now: fake.now
		}) as unknown as { prepare: (sql: string) => { all: () => Promise<unknown> } };

		const timing = await runWithRequestTiming(async (scope) => {
			// Both in flight before either resolves — the Promise.all shape.
			const both = Promise.all([db.prepare('a').all(), db.prepare('b').all()]);
			fake.advance(50);
			fake.settleAll();
			await both;
			return scope;
		});

		expect(timing.d1Calls).toBe(2);
		// Two calls, each genuinely 50ms long...
		expect(timing.d1DurationMs).toBe(100);
		// ...but only 50ms of wall time in which the request was waiting on D1.
		expect(timing.d1WallMs).toBe(50);
	});

	it('leaves sum and wall equal when calls do not overlap', async () => {
		const fake = createControllableD1();
		const db = instrumentD1(fake.database as unknown as D1Database, {
			now: fake.now
		}) as unknown as { prepare: (sql: string) => { all: () => Promise<unknown> } };

		const timing = await runWithRequestTiming(async (scope) => {
			const first = db.prepare('a').all();
			fake.advance(30);
			fake.settleAll();
			await first;

			const second = db.prepare('b').all();
			fake.advance(20);
			fake.settleAll();
			await second;

			return scope;
		});

		expect(timing.d1DurationMs).toBe(50);
		expect(timing.d1WallMs).toBe(50);
	});

	it('never leaves the union window open when a call rejects', async () => {
		const failing = {
			prepare: () => ({
				bind: () => failing.prepare(),
				all: async () => {
					throw new Error('D1_ERROR: boom');
				}
			})
		};
		let ticks = 0;
		const db = instrumentD1(failing as unknown as D1Database, {
			now: () => (ticks += 5)
		}) as unknown as { prepare: () => { all: () => Promise<unknown> } };

		const timing = await runWithRequestTiming(async (scope) => {
			await expect(db.prepare().all()).rejects.toThrow('boom');
			await expect(db.prepare().all()).rejects.toThrow('boom');
			return scope;
		});

		// A leaked `active` counter would stop the union ever closing again and
		// silently zero d1WallMs for the rest of the request.
		expect(timing.d1Calls).toBe(2);
		expect(timing.d1WallMs).toBeGreaterThan(0);
	});
});

describe('method binding (workerd shape)', () => {
	class BindingSensitiveStatement {
		constructor(
			private readonly owner: { ticks: number },
			readonly sql: string,
			readonly bound: readonly unknown[] = []
		) {}

		bind(...values: unknown[]) {
			return new BindingSensitiveStatement(this.owner, this.sql, values);
		}

		async all() {
			// Throws a TypeError if `this` is undefined, exactly as a workerd host
			// object throws "Illegal invocation".
			this.owner.ticks += 1;
			return { results: [{ sql: this.sql }], success: true };
		}

		async first() {
			this.owner.ticks += 1;
			return { sql: this.sql };
		}

		async run() {
			this.owner.ticks += 1;
			return { success: true };
		}

		async raw() {
			this.owner.ticks += 1;
			return [[this.sql]];
		}
	}

	class BindingSensitiveDatabase {
		ticks = 0;

		prepare(sql: string) {
			return new BindingSensitiveStatement(this, sql);
		}

		async batch(statements: BindingSensitiveStatement[]) {
			this.ticks += 1;
			return statements.map(() => ({ success: true }));
		}

		async exec(sql: string) {
			this.ticks += 1;
			return { count: 1, duration: 0, sql };
		}
	}

	it('calls statement methods with their own receiver', async () => {
		const real = new BindingSensitiveDatabase();
		const db = instrumentD1(real as unknown as D1Database);

		const timing = await runWithRequestTiming(async () => {
			await db.prepare('SELECT 1').bind(1).all();
			await db.prepare('SELECT 2').first();
			await db.prepare('SELECT 3').run();
			await db.prepare('SELECT 4').raw();
			return currentRequestTiming();
		});

		expect(real.ticks).toBe(4);
		expect(timing?.d1Calls).toBe(4);
	});

	it('calls database methods with their own receiver', async () => {
		const real = new BindingSensitiveDatabase();
		const db = instrumentD1(real as unknown as D1Database);

		await runWithRequestTiming(async () => {
			await db.exec('PRAGMA foreign_keys = ON');
			await db.batch([db.prepare('a') as never, db.prepare('b') as never]);
		});

		expect(real.ticks).toBe(2);
	});
});

describe('Server-Timing formatting', () => {
	it('emits the server total, the D1 total and the round-trip count', () => {
		const header = formatServerTiming({
			serverMs: 42.5,
			timing: { d1Calls: 6, d1Statements: 9, d1DurationMs: 31, d1WallMs: 20 }
		});

		// `dur` is the union (subtractable from srv); the sum rides in `desc`.
		expect(header).toBe('srv;dur=42.5, d1;dur=20;desc="n=6 stmts=9 sum=31"');
	});

	it('omits the D1 metric entirely when the request touched no database', () => {
		const header = formatServerTiming({
			serverMs: 3,
			timing: { d1Calls: 0, d1Statements: 0, d1DurationMs: 0, d1WallMs: 0 }
		});

		expect(header).toBe('srv;dur=3');
	});

	it('tolerates a missing accumulator', () => {
		expect(formatServerTiming({ serverMs: 8, timing: null })).toBe('srv;dur=8');
	});

	it('never emits a quote that would break the header grammar', () => {
		const header = formatServerTiming({
			serverMs: 1,
			timing: { d1Calls: 1, d1Statements: 1, d1DurationMs: 1, d1WallMs: 1 }
		});
		expect(header.match(/"/g)).toHaveLength(2);
	});
});
