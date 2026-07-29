/**
 * Per-request server-side timing (Increment 5 Task 4 follow-up).
 *
 * ## Why this exists
 *
 * Two 30-minute capacity gate runs on 2026-07-28 both failed and both ended at
 * the same sentence: *we cannot tell whether it is the network or D1*. They
 * could not tell because every number either run produced was client-observed
 * wall clock — the deployed Worker never measured its own time. (`recordPoll`
 * in `campaign-metrics.ts` was live at the call sites but no sink was ever
 * installed, so it was a no-op in production and staging alike.)
 *
 * This module produces the two quantities that settle it, per request:
 *
 * - **`srv`** — wall time spent inside the Worker. `total − srv`, measured by
 *   the client, is then the wire.
 * - **`d1`** — cumulative wall time inside D1 calls, with `n` the number of
 *   network round trips and `stmts` the number of statements they carried.
 *   `srv − d1` is Worker CPU plus non-D1 awaits.
 *
 * A batch is one round trip carrying many statements, so `n` and `stmts` are
 * counted separately. That distinction is the entire point: the leading
 * hypothesis in `docs/operations/campaign-capacity.md` is that command latency
 * is bound by round-trip *count* × Worker-to-primary distance, and collapsing
 * the two numbers into one would make that hypothesis untestable.
 *
 * ## Why AsyncLocalStorage
 *
 * The D1 binding is cached per isolate (`d1Contexts` in `db/index.ts`) and a
 * Workers isolate serves concurrent requests. A module-level counter would
 * therefore blend requests together and quietly report nonsense under exactly
 * the concurrency the capacity gate exists to measure. `AsyncLocalStorage` is
 * available under `nodejs_compat` on our compatibility date — see the note in
 * `wrangler.toml` — and `@sveltejs/kit` already depends on it.
 *
 * ## What `Date.now()` measures inside a Worker
 *
 * The Workers runtime advances the clock on I/O, not on CPU, as a timing
 * side-channel mitigation. So `srv` and `d1` here are **I/O wall time**, and a
 * request that spent real CPU but did no I/O can legitimately report `dur=0`.
 * That is a limitation worth stating plainly, and it is not a problem for the
 * question being asked: the whole diagnosis concerns round trips, which are
 * precisely the thing the clock does see. Do not "fix" this by reaching for
 * `performance.now()`, which is subject to the same mitigation.
 *
 * ## Privacy
 *
 * Durations and counts only. There is no field here that can carry a campaign
 * id, a card identity, a user id, an invite token or any part of a request
 * body — the same constraint `campaign-metrics.ts` enforces by shape. The
 * header this feeds is additionally gated off by default; see `hooks.server.ts`.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** Mutable per-request accumulator. Counts and durations only, by design. */
export interface RequestTiming {
	/** Network round trips to D1. A `batch()` is one, however many statements. */
	d1Calls: number;
	/** Statements issued across those round trips. */
	d1Statements: number;
	/**
	 * Sum of every call's own duration. **Double-counts concurrency** — the sync
	 * route issues `campaignCursor` and `findOpenSessionForCampaign` inside one
	 * `Promise.all`, so two 50 ms calls that overlap completely contribute 100 ms
	 * here while only 50 ms of wall time passes.
	 *
	 * This is the right numerator for *average per-round-trip latency*
	 * (`d1DurationMs / d1Calls`), which is what exposes Worker-to-primary
	 * distance. It is the wrong number to subtract from `srv`.
	 */
	d1DurationMs: number;
	/**
	 * Wall time during which at least one D1 call was in flight — the union of
	 * the call intervals, not their sum. This is the term that decomposes:
	 * `srv - d1WallMs` is genuinely Worker CPU plus non-D1 awaits.
	 *
	 * Added after the 2026-07-28 smoke run reported a poll D1 p50 of 252 ms
	 * against a server p50 of 209 ms — impossible for any single request, and so
	 * proof that the summed figure was counting overlap twice.
	 */
	d1WallMs: number;
}

const storage = new AsyncLocalStorage<RequestTiming>();

/**
 * Union bookkeeping, kept beside the accumulator rather than inside it so the
 * public shape stays "counts and durations only" and nothing internal leaks
 * into the header or a test's `toEqual`.
 *
 * `active` is a simple in-flight counter: the union grows only while it is
 * above zero, so overlapping calls contribute their covered span once.
 */
interface D1Bookkeeping {
	active: number;
	wallStartedAtMs: number;
}
const bookkeeping = new WeakMap<RequestTiming, D1Bookkeeping>();

/**
 * Runs `fn` inside a fresh timing scope. Everything `fn` awaits — including
 * the whole downstream `handle` sequence and route handler — is attributed to
 * the accumulator handed to it.
 */
export function runWithRequestTiming<T>(fn: (timing: RequestTiming) => Promise<T>): Promise<T> {
	const timing: RequestTiming = { d1Calls: 0, d1Statements: 0, d1DurationMs: 0, d1WallMs: 0 };
	return storage.run(timing, () => fn(timing));
}

/** The current request's accumulator, or `null` outside a request. */
export function currentRequestTiming(): RequestTiming | null {
	return storage.getStore() ?? null;
}

/**
 * Opens a D1 call against the current request, if any. Returns the accumulator
 * and start time to hand back to `endD1Call`. Outside a request scope both
 * halves are no-ops — background work and the unit suite must not have to care.
 */
function beginD1Call(now: () => number): { timing: RequestTiming | null; startedAt: number } {
	const timing = storage.getStore() ?? null;
	const startedAt = now();
	if (timing) {
		const book = bookkeeping.get(timing) ?? { active: 0, wallStartedAtMs: startedAt };
		// Only the OUTERMOST concurrent call opens the union window; the inner
		// ones just raise the count. That is what stops overlap being counted
		// twice.
		if (book.active === 0) book.wallStartedAtMs = startedAt;
		book.active += 1;
		bookkeeping.set(timing, book);
	}
	return { timing, startedAt };
}

/** Closes a D1 call. Records it whether it resolved or threw — see `timed`. */
function endD1Call(
	timing: RequestTiming | null,
	startedAt: number,
	endedAt: number,
	statements: number
): void {
	if (!timing) return;
	timing.d1Calls += 1;
	timing.d1Statements += statements;
	timing.d1DurationMs += Math.max(0, endedAt - startedAt);

	const book = bookkeeping.get(timing);
	if (!book) return;
	book.active -= 1;
	if (book.active <= 0) {
		book.active = 0;
		timing.d1WallMs += Math.max(0, endedAt - book.wallStartedAtMs);
	}
}

export interface InstrumentD1Options {
	/** Injectable clock. Production uses `Date.now`; the suite uses a fake. */
	now?: () => number;
}

/** Marks a wrapped statement and carries the real one underneath it. */
const REAL_STATEMENT = Symbol('guildbook.d1.realStatement');

/** Statement methods that actually cross the network. `bind()` does not. */
const STATEMENT_ROUND_TRIPS = new Set(['first', 'all', 'run', 'raw']);

/**
 * Wraps a `D1Database` so every round trip is counted and timed against the
 * current request.
 *
 * Implemented as a `Proxy` rather than a hand-written object on purpose:
 * Drizzle's D1 driver calls members this module has no knowledge of, and a
 * wrapper that enumerated a fixed method list would break the application the
 * first time the driver reached for something new. Anything not explicitly
 * instrumented passes straight through.
 *
 * `withSession()` is deliberately NOT instrumented — nothing in this codebase
 * uses D1 Sessions today, and a session's statements would pass through
 * uncounted rather than break. If Sessions are ever adopted, this is the place
 * that has to learn about them, or the round-trip count silently under-reports.
 */
export function instrumentD1(database: D1Database, options: InstrumentD1Options = {}): D1Database {
	const now = options.now ?? Date.now;

	async function timed<T>(statements: number, run: () => Promise<T>): Promise<T> {
		const { timing, startedAt } = beginD1Call(now);
		try {
			return await run();
		} finally {
			// `finally`, not the success path: `command-service.ts` treats a UNIQUE
			// violation as an ordinary lost-race outcome and retries, so a failed
			// round trip costs exactly as much wall time as a successful one and
			// must be counted. Omitting it would understate precisely the retrying
			// requests we most need to understand — and would also leave the union
			// window open forever, since `active` would never come back down.
			endD1Call(timing, startedAt, now(), statements);
		}
	}

	function passThrough(target: object, prop: string | symbol): unknown {
		const value = Reflect.get(target, prop, target);
		return typeof value === 'function' ? value.bind(target) : value;
	}

	function wrapStatement(statement: D1PreparedStatement): D1PreparedStatement {
		return new Proxy(statement, {
			get(target, prop) {
				if (prop === REAL_STATEMENT) return target;
				// Binding is local work; it issues nothing. Re-wrap so the bound
				// statement stays instrumented (and stays unwrappable for `batch`).
				if (prop === 'bind') {
					return (...values: unknown[]) =>
						wrapStatement((target.bind as (...v: unknown[]) => D1PreparedStatement)(...values));
				}
				if (typeof prop === 'string' && STATEMENT_ROUND_TRIPS.has(prop)) {
					const method = Reflect.get(target, prop, target) as (...a: unknown[]) => Promise<unknown>;
					// `.call(target, …)`, never a bare call. `Reflect.get` hands back an
					// UNBOUND method, and workerd's D1PreparedStatement is a real class
					// whose methods dereference `this` — invoking one without a receiver
					// throws "Illegal invocation" and breaks every query in the
					// application. Miniflare's implementation keeps its state in
					// closures and does not care, so the integration suite cannot catch
					// this; `method binding (workerd shape)` in the unit suite does.
					// Regression: this exact bug shipped to staging on 2026-07-28 and
					// turned every D1 read into a 500.
					return (...args: unknown[]) => timed(1, () => method.call(target, ...args));
				}
				return passThrough(target, prop);
			}
		});
	}

	function unwrapStatement(statement: D1PreparedStatement): D1PreparedStatement {
		const real = (statement as unknown as Record<symbol, D1PreparedStatement>)?.[REAL_STATEMENT];
		return real ?? statement;
	}

	return new Proxy(database, {
		get(target, prop) {
			if (prop === 'prepare') {
				return (query: string) => wrapStatement(target.prepare(query));
			}
			if (prop === 'batch') {
				return (statements: D1PreparedStatement[]) => {
					// The Workers runtime rejects a Proxy where it expects a real
					// D1PreparedStatement, so the wrappers must be peeled off before
					// the list crosses the boundary. `runAtomic` in db/atomic.ts is
					// the caller this matters for.
					const real = statements.map(unwrapStatement);
					return timed(real.length, () => target.batch(real));
				};
			}
			if (prop === 'exec') {
				// `exec()` runs EVERY newline-separated statement in the string, so
				// counting it as one would under-report `stmts=` the first time
				// anything uses it — and a trustworthy statement count is the only
				// reason this module exists. Nothing calls `exec` on a request path
				// today; this is here so that stays true if something does.
				return (query: string) =>
					timed(countExecStatements(query), () => target.exec(query));
			}
			return passThrough(target, prop);
		}
	});
}

export interface ServerTimingInput {
	/** Wall time spent inside the Worker, milliseconds. */
	serverMs: number;
	timing: RequestTiming | null;
}

/**
 * Renders a `Server-Timing` header value.
 *
 * Standard header rather than a bespoke one so it also shows up in browser
 * devtools without any tooling. `desc` carries the counts because the grammar
 * gives a metric exactly one numeric `dur`, and emitting a count in a field
 * named "duration" would be a lie in the wire format.
 *
 * `dur` is the **union** (`d1WallMs`), because that is the term that subtracts
 * from `srv` to leave Worker CPU. The **sum** rides along in `desc` as `sum=`,
 * because that is the right numerator for average per-round-trip latency. They
 * differ exactly as much as the route overlaps its queries, so `sum/dur` is
 * also a free read on how much parallelism a route actually achieves.
 *
 * The D1 metric is omitted entirely when a request touched no database — a
 * cursor-hint `204` is the common case in the gate, and reporting `dur=0`
 * would be indistinguishable from a request whose D1 time rounded to zero.
 */
export function formatServerTiming({ serverMs, timing }: ServerTimingInput): string {
	const parts = [`srv;dur=${round(serverMs)}`];
	if (timing && timing.d1Calls > 0) {
		// Every interpolation is a number from this module's own counters, so no
		// value here can introduce a quote and break the grammar.
		parts.push(
			`d1;dur=${round(timing.d1WallMs)};desc="n=${timing.d1Calls} stmts=${timing.d1Statements} sum=${round(timing.d1DurationMs)}"`
		);
	}
	return parts.join(', ');
}

/**
 * How many statements a `D1Database.exec` call carries. D1 splits on newlines
 * and requires one complete statement per line, so this matches its own
 * semantics rather than trying to parse SQL. Always at least one, so a call is
 * never recorded as carrying zero statements.
 */
function countExecStatements(query: string): number {
	if (typeof query !== 'string') return 1;
	const lines = query.split('\n').filter((line) => line.trim().length > 0);
	return Math.max(1, lines.length);
}

function round(value: number): number {
	if (!Number.isFinite(value) || value < 0) return 0;
	return Math.round(value * 10) / 10;
}
