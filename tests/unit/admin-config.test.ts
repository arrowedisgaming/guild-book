import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AppDb } from '$lib/server/db';
import * as schema from '$lib/server/db/schema';
import { users } from '$lib/server/db/schema';
import type { RequestEvent } from '@sveltejs/kit';

/** Set up mocks for `getUserId` and `getDb` before importing the module under test. */
const mocks = vi.hoisted(() => ({
	getUserId: vi.fn(),
	getDb: vi.fn()
}));

vi.mock('$lib/server/auth', () => ({
	getEnv: (event: { platform?: { env?: Record<string, string> } }, key: string) =>
		event.platform?.env?.[key],
	getUserId: mocks.getUserId
}));

vi.mock('$lib/server/db', () => ({
	getDb: mocks.getDb
}));

// Now import the module under test, which will use the mocked dependencies
import { getAdminConfig, isAdminEmail, requireAdmin } from '$lib/server/admin/config';

/** `getEnv` reads `event.platform.env` first, which is all these tests need. */
function eventWith(env: Record<string, string>): RequestEvent {
	return { platform: { env } } as unknown as RequestEvent;
}

/** Set up in-memory SQLite database with migrations applied. */
function makeDb(): { db: AppDb; sqlite: Database.Database } {
	const sqlite = new Database(':memory:');
	sqlite.pragma('foreign_keys = ON');
	const directory = join(process.cwd(), 'src/lib/server/db/migrations');
	for (const filename of readdirSync(directory).filter((n) => n.endsWith('.sql')).sort()) {
		sqlite.exec(readFileSync(join(directory, filename), 'utf8'));
	}
	return { db: drizzle(sqlite, { schema }) as unknown as AppDb, sqlite };
}

describe('getAdminConfig', () => {
	it('yields an empty set when ADMIN_EMAILS is unset', () => {
		expect(getAdminConfig(eventWith({})).adminEmails.size).toBe(0);
	});

	it('yields an empty set when ADMIN_EMAILS is blank or only separators', () => {
		expect(getAdminConfig(eventWith({ ADMIN_EMAILS: '   ' })).adminEmails.size).toBe(0);
		expect(getAdminConfig(eventWith({ ADMIN_EMAILS: ',,' })).adminEmails.size).toBe(0);
	});

	it('splits, trims, and lowercases entries', () => {
		const config = getAdminConfig(eventWith({ ADMIN_EMAILS: ' Owner@Example.Test , two@example.test' }));

		expect([...config.adminEmails].sort()).toEqual(['owner@example.test', 'two@example.test']);
	});
});

describe('isAdminEmail', () => {
	const config = getAdminConfig(eventWith({ ADMIN_EMAILS: 'owner@example.test' }));

	it('matches regardless of casing or surrounding whitespace', () => {
		expect(isAdminEmail(config, 'Owner@Example.Test')).toBe(true);
		expect(isAdminEmail(config, ' owner@example.test ')).toBe(true);
	});

	it('rejects a null, undefined, or empty email', () => {
		expect(isAdminEmail(config, null)).toBe(false);
		expect(isAdminEmail(config, undefined)).toBe(false);
		expect(isAdminEmail(config, '')).toBe(false);
	});

	it('rejects a substring or superstring of an admin address', () => {
		expect(isAdminEmail(config, 'owner@example.tes')).toBe(false);
		expect(isAdminEmail(config, 'notowner@example.test')).toBe(false);
		expect(isAdminEmail(config, 'owner@example.test.evil.test')).toBe(false);
	});

	it('fails closed against an empty allowlist', () => {
		const empty = getAdminConfig(eventWith({}));
		expect(isAdminEmail(empty, 'owner@example.test')).toBe(false);
	});
});

describe('requireAdmin', () => {
	let db: AppDb;
	let sqlite: Database.Database;

	beforeEach(() => {
		vi.clearAllMocks();
		({ db, sqlite } = makeDb());
		mocks.getDb.mockResolvedValue(db);
	});

	it('throws 404 when the user is anonymous (getUserId resolves null)', async () => {
		mocks.getUserId.mockResolvedValue(null);

		const event = eventWith({ ADMIN_EMAILS: 'admin@example.test' });

		try {
			await requireAdmin(event);
			expect.fail('should have thrown');
		} catch (err: unknown) {
			expect((err as { status: number }).status).toBe(404);
		}
	});

	it('throws 404 when the signed-in user is not in the allowlist', async () => {
		const userId = 'user-1';
		await db.insert(users).values({
			id: userId,
			email: 'user@example.test'
		});
		mocks.getUserId.mockResolvedValue(userId);

		const event = eventWith({ ADMIN_EMAILS: 'admin@example.test' });

		try {
			await requireAdmin(event);
			expect.fail('should have thrown');
		} catch (err: unknown) {
			expect((err as { status: number }).status).toBe(404);
		}
	});

	it('throws 404 when ADMIN_EMAILS is unset even if a user is signed in', async () => {
		const userId = 'user-2';
		await db.insert(users).values({
			id: userId,
			email: 'admin@example.test'
		});
		mocks.getUserId.mockResolvedValue(userId);

		const event = eventWith({});

		try {
			await requireAdmin(event);
			expect.fail('should have thrown');
		} catch (err: unknown) {
			expect((err as { status: number }).status).toBe(404);
		}
	});

	it('throws 404 when the user row has a null email', async () => {
		const userId = 'user-3';
		await db.insert(users).values({
			id: userId,
			email: null
		});
		mocks.getUserId.mockResolvedValue(userId);

		const event = eventWith({ ADMIN_EMAILS: 'admin@example.test' });

		try {
			await requireAdmin(event);
			expect.fail('should have thrown');
		} catch (err: unknown) {
			expect((err as { status: number }).status).toBe(404);
		}
	});

	it('resolves with userId and email when the user is in the allowlist', async () => {
		const userId = 'user-4';
		const userEmail = 'admin@example.test';
		await db.insert(users).values({
			id: userId,
			email: userEmail
		});
		mocks.getUserId.mockResolvedValue(userId);

		const event = eventWith({ ADMIN_EMAILS: 'admin@example.test' });

		const result = await requireAdmin(event);

		expect(result).toEqual({
			userId,
			email: userEmail
		});
	});

	it('matches admin email case-insensitively', async () => {
		const userId = 'user-5';
		const userEmail = 'admin@example.test';
		await db.insert(users).values({
			id: userId,
			email: userEmail
		});
		mocks.getUserId.mockResolvedValue(userId);

		const event = eventWith({ ADMIN_EMAILS: 'ADMIN@EXAMPLE.TEST' });

		const result = await requireAdmin(event);

		expect(result).toEqual({
			userId,
			email: userEmail
		});
	});
});
