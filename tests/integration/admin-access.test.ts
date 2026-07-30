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
	// `first_seen_at`/`last_seen_at`/`created_at` are `mode: 'timestamp'` columns
	// (unix seconds, not milliseconds) — a seconds/milliseconds inversion in the
	// admin load's `gte(..., since)` comparisons must be caught here rather than
	// slip through as a silently-empty "active" or "new" figure.
	const NOW_SECONDS = Math.floor(Date.now() / 1000);
	const RECENT_SECONDS = NOW_SECONDS - 60 * 60; // 1 hour ago: inside the 7-day window
	const STALE_SECONDS = 1000; // 1970: well outside any 7-day window

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
		// plain-user signed in recently, so they count toward the 7-day
		// "active" figure; admin-user never has, so they must not.
		sqlite
			.prepare(
				'INSERT INTO users (id, name, email, login_count, last_seen_at) VALUES (?, ?, ?, ?, ?)'
			)
			.run('plain-user', 'Tester', 'tester@example.test', 1, RECENT_SECONDS);
		sqlite
			.prepare(
				'INSERT INTO characters (id, user_id, name, kith, path, data, is_draft, is_archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
			)
			.run('char-1', 'plain-user', 'Old Tom', 'Human', 'Fighter', '{}', 0, 0, STALE_SECONDS, STALE_SECONDS);
		sqlite
			.prepare(
				'INSERT INTO characters (id, user_id, name, kith, path, data, is_draft, is_archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
			)
			.run('char-2', 'plain-user', 'Draft Dan', 'Elf', 'Thief', '{}', 1, 0, STALE_SECONDS, STALE_SECONDS);
		// Archived but otherwise complete — must still show up (and still show
		// as archived) in the adventurers table and in the aggregate counts.
		sqlite
			.prepare(
				'INSERT INTO characters (id, user_id, name, kith, path, data, is_draft, is_archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
			)
			.run('char-3', 'plain-user', 'Old Gravedigger', 'Human', 'Fighter', '{}', 0, 1, STALE_SECONDS, STALE_SECONDS);
		// Created recently, so it counts toward the 7-day "new characters"
		// figure; the other three (created at STALE_SECONDS) must not.
		sqlite
			.prepare(
				'INSERT INTO characters (id, user_id, name, kith, path, data, is_draft, is_archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
			)
			.run('char-4', 'plain-user', 'New Nell', 'Human', 'Fighter', '{}', 0, 0, RECENT_SECONDS, RECENT_SECONDS);
		sqlite
			.prepare(
				'INSERT INTO denizens (id, user_id, name, theme, threat, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
			)
			.run('denizen-1', 'plain-user', 'The Rat King', 'Vermin', 'Swarm', '{}', 1000, 1000);

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
			characters: Array<{ id: string; isDraft: boolean; isArchived: boolean }>;
		};

		expect(data.summary.totalUsers).toBe(2);
		expect(data.summary.totalCharacters).toBe(4);
		expect(data.summary.draftCharacters).toBe(1);
		expect(data.summary.completedCharacters).toBe(3);
		expect(data.summary.totalDenizens).toBe(1);
		// Time-windowed aggregates: plain-user (last_seen_at 1h ago) is active,
		// admin-user (never seen) is not; char-4 (created 1h ago) is new, the
		// other three (created in 1970) are not. Both figures are structurally
		// 0 under a seconds/milliseconds inversion in the `gte(..., since)`
		// comparison, so this is the only thing that would catch one.
		expect(data.summary.activeUsers).toBe(1);
		expect(data.summary.newCharacters).toBe(1);
		expect(data.users).toHaveLength(2);
		expect(data.characters).toHaveLength(4);

		// The inclusion property, exercised: an archived character is not
		// dropped from the table, and its archived state survives the read.
		const archived = data.characters.find((row) => row.id === 'char-3');
		expect(archived).toBeDefined();
		expect(archived?.isArchived).toBe(true);
		expect(archived?.isDraft).toBe(false);

		// Per-user adventurer counts: plain-user owns four characters,
		// admin-user owns none. A correlated subquery that loses its table
		// qualifier collapses to `characters.user_id = characters.id`, which is
		// never true and silently reports 0 for every user — this pins the
		// correct counts so that regression can't hide again.
		const usersById = new Map((data.users as Array<{ id: string; characterCount: number }>).map(
			(row) => [row.id, row.characterCount]
		));
		expect(usersById.get('plain-user')).toBe(4);
		expect(usersById.get('admin-user')).toBe(0);
	});

	it('clamps unrecognised sort and page params instead of erroring', async () => {
		mocks.getUserId.mockResolvedValue('admin-user');
		const data = (await load(
			adminEvent({ userSort: 'DROP TABLE users', usersPage: '-9', charactersPage: 'abc' }) as never
		)) as { users: unknown[]; usersPage: number };

		expect(data.usersPage).toBe(1);
		expect(data.users).toHaveLength(2);
	});

	it('clamps a page value of 0 to page 1', async () => {
		mocks.getUserId.mockResolvedValue('admin-user');
		const data = (await load(adminEvent({ usersPage: '0' }) as never)) as { usersPage: number };

		expect(data.usersPage).toBe(1);
	});

	it('clamps an astronomically large page instead of producing an unsafe OFFSET', async () => {
		mocks.getUserId.mockResolvedValue('admin-user');
		const data = (await load(
			adminEvent({ usersPage: '9007199254740993' }) as never
		)) as { usersPage: number; users: unknown[] };

		expect(Number.isSafeInteger(data.usersPage)).toBe(true);
		expect(data.users).toHaveLength(0);
	});

	it('offers no Next link on a full last page (exact multiple of PAGE_SIZE)', async () => {
		// Seed up to exactly one full page of each: 50 users and 50 characters.
		// A full page must not be read as evidence of a next page.
		const insertUser = sqlite.prepare(
			'INSERT INTO users (id, name, email, login_count) VALUES (?, ?, ?, ?)'
		);
		for (let i = 0; i < 48; i++) {
			insertUser.run(`filler-user-${i}`, `Filler ${i}`, `filler-${i}@example.test`, 0);
		}
		const insertCharacter = sqlite.prepare(
			'INSERT INTO characters (id, user_id, name, kith, path, data, is_draft, is_archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
		);
		for (let i = 0; i < 46; i++) {
			insertCharacter.run(`filler-char-${i}`, 'plain-user', `Filler ${i}`, '', '', '{}', 0, 0, STALE_SECONDS, STALE_SECONDS);
		}

		mocks.getUserId.mockResolvedValue('admin-user');
		const data = (await load(adminEvent() as never)) as {
			users: unknown[];
			characters: unknown[];
			usersHasNext: boolean;
			charactersHasNext: boolean;
		};

		expect(data.users).toHaveLength(50);
		expect(data.characters).toHaveLength(50);
		expect(data.usersHasNext).toBe(false);
		expect(data.charactersHasNext).toBe(false);
	});

	it('offers a Next link only while rows remain beyond the current page', async () => {
		// 51 users: page 1 is full and has a next page; page 2 has one row and
		// does not.
		const insertUser = sqlite.prepare(
			'INSERT INTO users (id, name, email, login_count) VALUES (?, ?, ?, ?)'
		);
		for (let i = 0; i < 49; i++) {
			insertUser.run(`filler-user-${i}`, `Filler ${i}`, `filler-${i}@example.test`, 0);
		}

		mocks.getUserId.mockResolvedValue('admin-user');
		const pageOne = (await load(adminEvent() as never)) as {
			users: unknown[];
			usersHasNext: boolean;
		};
		expect(pageOne.users).toHaveLength(50);
		expect(pageOne.usersHasNext).toBe(true);

		const pageTwo = (await load(adminEvent({ usersPage: '2' }) as never)) as {
			users: unknown[];
			usersHasNext: boolean;
		};
		expect(pageTwo.users).toHaveLength(1);
		expect(pageTwo.usersHasNext).toBe(false);
	});

	it('returns an empty page past the last page instead of erroring', async () => {
		mocks.getUserId.mockResolvedValue('admin-user');
		const data = (await load(
			adminEvent({ usersPage: '5', charactersPage: '5' }) as never
		)) as { usersPage: number; charactersPage: number; users: unknown[]; characters: unknown[] };

		expect(data.usersPage).toBe(5);
		expect(data.charactersPage).toBe(5);
		expect(data.users).toHaveLength(0);
		expect(data.characters).toHaveLength(0);
	});
});
