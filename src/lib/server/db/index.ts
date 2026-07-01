import * as schema from './schema';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import type { RequestEvent } from '@sveltejs/kit';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

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

let nodeDb: AppDb | undefined;
const d1Databases = new WeakMap<D1Database, DrizzleD1Database<typeof schema>>();

function getD1Db(database: D1Database): DrizzleD1Database<typeof schema> {
	const existing = d1Databases.get(database);
	if (existing) return existing;

	const db = drizzleD1(database, { schema });
	d1Databases.set(database, db);
	return db;
}

async function getNodeDb(): Promise<BetterSQLite3Database<typeof schema>> {
	if (nodeDb) return nodeDb;

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

	nodeDb = drizzle(sqlite, { schema });
	return nodeDb;
}

export async function getDb(event?: Pick<RequestEvent, 'platform'>): Promise<AppDb> {
	const platform = event?.platform as PlatformWithD1 | undefined;
	if (platform?.env?.DB) {
		return getD1Db(platform.env.DB) as unknown as AppDb;
	}

	return getNodeDb();
}
