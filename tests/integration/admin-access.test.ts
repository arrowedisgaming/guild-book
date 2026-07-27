import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import * as schema from '$lib/server/db/schema';

const mocks = vi.hoisted(() => ({
	getUserId: vi.fn(),
	getEnv: vi.fn(
		(event: { platform?: { env?: Record<string, string> } }, key: string) =>
			event.platform?.env?.[key]
	),
	getDb: vi.fn()
}));

vi.mock('$lib/server/auth', () => ({ getUserId: mocks.getUserId, getEnv: mocks.getEnv }));
vi.mock('$lib/server/db', () => ({ getDb: mocks.getDb }));

import { load } from '../../src/routes/admin/+page.server';

const ADMIN_EMAIL = 'owner@example.test';

function adminEvent(searchParams: Record<string, string> = {}): RequestEvent {
	const url = new URL('http://localhost/admin');
	for (const [key, value] of Object.entries(searchParams)) url.searchParams.set(key, value);
	return { url, platform: { env: { ADMIN_EMAILS: ADMIN_EMAIL } } } as unknown as RequestEvent;
}

async function statusOf(run: () => unknown): Promise<number> {
	try {
		await run();
		return 200;
	} catch (err) {
		return (err as { status?: number }).status ?? 500;
	}
}

describe('admin page access', () => {
	let sqlite: Database.Database;

	beforeEach(() => {
		vi.clearAllMocks();
		sqlite = new Database(':memory:');
		sqlite.pragma('foreign_keys = ON');
		const directory = join(process.cwd(), 'src/lib/server/db/migrations');
		for (const filename of readdirSync(directory).filter((n) => n.endsWith('.sql')).sort()) {
			sqlite.exec(readFileSync(join(directory, filename), 'utf8'));
		}

		sqlite
			.prepare('INSERT INTO users (id, name, email, login_count) VALUES (?, ?, ?, ?)')
			.run('admin-user', 'Owner', ADMIN_EMAIL, 4);
		sqlite
			.prepare('INSERT INTO users (id, name, email, login_count) VALUES (?, ?, ?, ?)')
			.run('plain-user', 'Tester', 'tester@example.test', 1);
		sqlite
			.prepare(
				'INSERT INTO characters (id, user_id, name, kith, path, data, is_draft, is_archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
			)
			.run('char-1', 'plain-user', 'Old Tom', 'Human', 'Fighter', '{}', 0, 0, 1000, 1000);
		sqlite
			.prepare(
				'INSERT INTO characters (id, user_id, name, kith, path, data, is_draft, is_archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
			)
			.run('char-2', 'plain-user', 'Draft Dan', 'Elf', 'Thief', '{}', 1, 0, 1000, 1000);

		mocks.getDb.mockResolvedValue(drizzle(sqlite, { schema }));
	});

	it('404s for an anonymous visitor', async () => {
		mocks.getUserId.mockResolvedValue(null);
		expect(await statusOf(() => load(adminEvent() as never))).toBe(404);
	});

	it('404s for a signed-in non-admin', async () => {
		mocks.getUserId.mockResolvedValue('plain-user');
		expect(await statusOf(() => load(adminEvent() as never))).toBe(404);
	});

	it('404s when ADMIN_EMAILS is unset', async () => {
		mocks.getUserId.mockResolvedValue('admin-user');
		const event = { url: new URL('http://localhost/admin'), platform: { env: {} } };
		expect(await statusOf(() => load(event as never))).toBe(404);
	});

	it('404s when the session claims an admin email the users row does not have', async () => {
		// The spoof case: only the stored column is authoritative.
		mocks.getUserId.mockResolvedValue('plain-user');
		const event = {
			url: new URL('http://localhost/admin'),
			platform: { env: { ADMIN_EMAILS: ADMIN_EMAIL } },
			locals: { auth: async () => ({ user: { id: 'plain-user', email: ADMIN_EMAIL } }) }
		};
		expect(await statusOf(() => load(event as never))).toBe(404);
	});

	it('returns summary figures and rows for an admin', async () => {
		mocks.getUserId.mockResolvedValue('admin-user');
		const data = (await load(adminEvent() as never)) as {
			summary: Record<string, number>;
			users: unknown[];
			characters: unknown[];
		};

		expect(data.summary.totalUsers).toBe(2);
		expect(data.summary.totalCharacters).toBe(2);
		expect(data.summary.draftCharacters).toBe(1);
		expect(data.summary.completedCharacters).toBe(1);
		expect(data.summary.totalDenizens).toBe(0);
		expect(data.users).toHaveLength(2);
		expect(data.characters).toHaveLength(2);
	});

	it('clamps unrecognised sort and page params instead of erroring', async () => {
		mocks.getUserId.mockResolvedValue('admin-user');
		const data = (await load(
			adminEvent({ userSort: 'DROP TABLE users', usersPage: '-9', charactersPage: 'abc' }) as never
		)) as { users: unknown[]; usersPage: number };

		expect(data.usersPage).toBe(1);
		expect(data.users).toHaveLength(2);
	});
});
