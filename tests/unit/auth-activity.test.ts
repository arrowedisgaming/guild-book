import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '$lib/server/db';
import * as schema from '$lib/server/db/schema';
import { users } from '$lib/server/db/schema';
import { AUTH_SESSION_VERSION, createAuthCallbacks } from '$lib/server/auth-policy';

function makeDb(): { db: AppDb; sqlite: Database.Database } {
	const sqlite = new Database(':memory:');
	sqlite.pragma('foreign_keys = ON');
	const directory = join(process.cwd(), 'src/lib/server/db/migrations');
	for (const filename of readdirSync(directory).filter((n) => n.endsWith('.sql')).sort()) {
		sqlite.exec(readFileSync(join(directory, filename), 'utf8'));
	}
	return { db: drizzle(sqlite, { schema }) as unknown as AppDb, sqlite };
}

/** The `jwt` callback's signature is wide; tests only ever pass these fields. */
type JwtArgs = Parameters<NonNullable<ReturnType<typeof createAuthCallbacks>['jwt']>>[0];

describe('auth activity recording', () => {
	let db: AppDb;

	beforeEach(() => {
		({ db } = makeDb());
	});

	async function readUser(id: string) {
		return db
			.select({
				firstSeenAt: users.firstSeenAt,
				lastSeenAt: users.lastSeenAt,
				loginCount: users.loginCount
			})
			.from(users)
			.where(eq(users.id, id))
			.get();
	}

	it('increments loginCount and stamps firstSeenAt on sign-in', async () => {
		await db.insert(users).values({ id: 'user-a', email: 'a@example.test' });
		const callbacks = createAuthCallbacks(db);

		await callbacks.jwt!({ token: {}, user: { id: 'user-a' } } as unknown as JwtArgs);

		const row = await readUser('user-a');
		expect(row?.loginCount).toBe(1);
		expect(row?.firstSeenAt).toBeInstanceOf(Date);
		expect(row?.lastSeenAt).toBeInstanceOf(Date);
	});

	it('stamps lastSeenAt without incrementing loginCount when resuming', async () => {
		await db.insert(users).values({ id: 'user-b', email: 'b@example.test' });
		const callbacks = createAuthCallbacks(db);

		const token = { sub: 'user-b', sessionVersion: AUTH_SESSION_VERSION };
		const result = await callbacks.jwt!({ token } as unknown as JwtArgs);

		expect(result).toBe(token);
		const row = await readUser('user-b');
		expect(row?.loginCount).toBe(0);
		expect(row?.lastSeenAt).toBeInstanceOf(Date);
	});

	it('keeps the session valid when the activity write throws', async () => {
		await db.insert(users).values({ id: 'user-c', email: 'c@example.test' });
		const callbacks = createAuthCallbacks(db);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(db, 'update').mockImplementation(() => {
			throw new Error('D1 unavailable');
		});

		const token = { sub: 'user-c', sessionVersion: AUTH_SESSION_VERSION };
		const result = await callbacks.jwt!({ token } as unknown as JwtArgs);

		// The whole point: an analytics failure must never sign a user out.
		expect(result).toBe(token);
		expect(warn).toHaveBeenCalled();
		vi.restoreAllMocks();
	});

	it('still invalidates a token whose user row is gone', async () => {
		const callbacks = createAuthCallbacks(db);

		const result = await callbacks.jwt!({
			token: { sub: 'user-missing', sessionVersion: AUTH_SESSION_VERSION }
		} as unknown as JwtArgs);

		expect(result).toBeNull();
	});
});
