/**
 * Raw-target atomic execution for the shared tarot table's session services
 * (Task 5). Distinct from `$lib/server/campaign/atomic.ts` (Increment 1),
 * which batches prebuilt Drizzle query-builder statements — that shape can't
 * express the read-your-own-writes-within-one-transaction SQL this task
 * needs (see `session/repository.ts`'s campaign-event id assignment), so
 * this module instead executes a finite list of hand-built, parameterized
 * `{ sql, params }` statements directly against the underlying driver:
 * `better-sqlite3`'s `Database.transaction` on Node, `D1Database.batch` on
 * Cloudflare. Both execute their statement list as one all-or-nothing unit,
 * in order, with each later statement able to see earlier statements'
 * writes (ordinary same-transaction visibility) — see `repository.ts`'s
 * `campaignEventInsertStatement`/`campaignEventSecretInsertStatement` for why
 * that visibility matters.
 *
 * `runAtomic` never accepts a raw SQL string built by concatenating
 * user-controlled data — every statement's `sql` is a fixed string literal
 * written by this codebase; only `params` (always bound, never interpolated)
 * carry request-derived values.
 */

import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from './schema';

/** One parameterized mutation statement. `sql` is always a fixed literal
 * written in this codebase; `params` are bound positionally (`?` placeholders). */
export interface AtomicStatement {
	sql: string;
	params: readonly unknown[];
}

export function statement(sql: string, params: readonly unknown[] = []): AtomicStatement {
	return { sql, params };
}

/** The raw-target DB handle: a typed Drizzle query surface (`db`, for reads)
 * paired with the underlying driver (`raw`, for `runAtomic`'s parameterized
 * writes). `event.locals.db` stays the pre-existing common query surface for
 * all other reads; `event.locals.dbContext` is this richer union, used only
 * by code that needs `runAtomic`. */
export type AppDbContext =
	| { kind: 'sqlite'; db: BetterSQLite3Database<typeof schema>; raw: import('better-sqlite3').Database }
	| { kind: 'd1'; db: DrizzleD1Database<typeof schema>; raw: D1Database };

/**
 * Executes `statements` as one all-or-nothing unit. SQLite: prepares and
 * runs each statement inside `raw.transaction` (synchronous; a thrown error
 * rolls back everything). D1: prepares+binds each statement and hands the
 * list to `raw.batch`, which Cloudflare documents as executing sequentially
 * inside a single transaction — a rejected statement (e.g. a unique/check
 * constraint violation) rolls back the whole batch. An empty statement list
 * is a no-op.
 */
export async function runAtomic(ctx: AppDbContext, statements: readonly AtomicStatement[]): Promise<void> {
	if (statements.length === 0) return;

	if (ctx.kind === 'sqlite') {
		const raw = ctx.raw;
		const run = raw.transaction((stmts: readonly AtomicStatement[]) => {
			for (const stmt of stmts) {
				raw.prepare(stmt.sql).run(...(stmt.params as unknown[]));
			}
		});
		run(statements);
		return;
	}

	const prepared = statements.map((stmt) => ctx.raw.prepare(stmt.sql).bind(...(stmt.params as unknown[])));
	await ctx.raw.batch(prepared);
}

/** True when `error` looks like a SQLite/D1 UNIQUE constraint violation —
 * the signal both drivers raise for a lost version/idempotency-key claim
 * race (see `session_commands_resulting_version_uq` /
 * `session_commands_session_command_uq` in `db/schema.ts`). Message-based
 * because that's the only thing SQLite and D1 agree on; both embed "UNIQUE
 * constraint failed" verbatim. */
export function isUniqueConstraintError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /unique constraint/i.test(message);
}
