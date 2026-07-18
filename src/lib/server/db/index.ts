import * as schema from './schema';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import type { RequestEvent } from '@sveltejs/kit';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { AppDbContext } from './atomic';

// Dual-target resolver: Cloudflare D1 in production (via platform.env.DB),
// better-sqlite3 for local Node dev. Same Drizzle schema and queries either
// way — this is what makes "D1 primary, Node fallback" free.

type PlatformWithD1 = {
	env?: {
		DB?: D1Database;
	};
};
type BetterSqliteConstructor = typeof import('better-sqlite3');
type DynamicImport = <T>(specifier: string) => Promise<T>;

export type AppDb = BetterSQLite3Database<typeof schema>;
export type { AppDbContext } from './atomic';

let nodeContext: AppDbContext | undefined;
const d1Contexts = new WeakMap<D1Database, AppDbContext>();

function getD1Context(database: D1Database): AppDbContext {
	const existing = d1Contexts.get(database);
	if (existing) return existing;

	const db = drizzleD1(database, { schema });
	const context: AppDbContext = { kind: 'd1', db, raw: database };
	d1Contexts.set(database, context);
	return context;
}

async function getNodeContext(): Promise<AppDbContext> {
	if (nodeContext) return nodeContext;

	const dynamicImport = new Function('specifier', 'return import(specifier)') as DynamicImport;
	const [{ drizzle }, databaseModule] = await Promise.all([
		dynamicImport<typeof import('drizzle-orm/better-sqlite3')>('drizzle-orm/better-sqlite3'),
		dynamicImport<unknown>('better-sqlite3')
	]);
	const Database =
		(databaseModule as { default?: BetterSqliteConstructor }).default ??
		(databaseModule as BetterSqliteConstructor);
	const databaseUrl = process.env.DATABASE_URL ?? 'local.db';
	const sqlite = new Database(databaseUrl);

	sqlite.pragma('journal_mode = WAL');
	sqlite.pragma('foreign_keys = ON');

	const db = drizzle(sqlite, { schema });
	nodeContext = { kind: 'sqlite', db, raw: sqlite };
	return nodeContext;
}

/** The raw-target context (typed Drizzle query surface + underlying driver),
 * for code that needs `runAtomic` (`$lib/server/db/atomic.ts`) — currently
 * the session command/lifecycle services. Cached per-D1-instance / per-Node-
 * process exactly like `getDb`, and in fact backs it (see below), so this
 * never opens a second connection alongside `getDb`. */
export async function getDbContext(event?: Pick<RequestEvent, 'platform'>): Promise<AppDbContext> {
	const platform = event?.platform as PlatformWithD1 | undefined;
	if (platform?.env?.DB) {
		return getD1Context(platform.env.DB);
	}

	return getNodeContext();
}

/** The common Drizzle query surface used by all existing reads/writes.
 * Unsound but harmless cast: D1's and better-sqlite3's Drizzle query
 * builders expose the same chainable methods (`.get()`/`.run()`/etc.) at
 * runtime even though their TypeScript types differ — every pre-Task-5 call
 * site already relied on this, so `getDb` keeps returning the same `AppDb`
 * shape those call sites expect. New code that needs the real underlying
 * driver (raw prepared statements, atomic batches) should use
 * `getDbContext` instead. */
export async function getDb(event?: Pick<RequestEvent, 'platform'>): Promise<AppDb> {
	const context = await getDbContext(event);
	return context.db as unknown as AppDb;
}
