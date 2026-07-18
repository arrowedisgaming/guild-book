/**
 * Handler tests for /api/denizens against an in-memory better-sqlite3 drizzle
 * DB (the auth-lifecycle pattern), covering ownership, the anonymous-401
 * path, validation, sanitize-on-read, and optimistic concurrency.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { error } from '@sveltejs/kit';
import type { AppDb } from '$lib/server/db';
import * as schema from '$lib/server/db/schema';
import {
	createBlankDraft,
	createBlankPoolDraft,
	sanitizeDraft,
	seedFromTemplates,
	updatePool
} from '$lib/engine/denizen-builder';
import { getDenizenThemes, getDenizenThreats } from '$lib/server/content/loader';

let db: AppDb;
let currentUserId: string | null = null;

vi.mock('$lib/server/db', () => ({
	getDb: async () => db
}));
vi.mock('$lib/server/auth', () => ({
	ensureUser: async () => {
		if (!currentUserId) throw error(401, 'Sign in required');
		return currentUserId;
	}
}));

// Import after the mocks so the handlers bind to the test doubles.
const listHandlers = await import('../../src/routes/api/denizens/+server');
const itemHandlers = await import('../../src/routes/api/denizens/[id]/+server');

const migrations = [
	'0000_dashing_surge.sql',
	'0001_auth_account_uniqueness.sql',
	'0002_auth_email_normalization.sql',
	'0008_saved_denizens.sql'
].map((file) =>
	readFileSync(new URL(`../../src/lib/server/db/migrations/${file}`, import.meta.url), 'utf8')
);

let sqlite: Database.Database;

beforeEach(() => {
	sqlite = new Database(':memory:');
	sqlite.pragma('foreign_keys = ON');
	for (const migration of migrations) sqlite.exec(migration);
	db = drizzle(sqlite, { schema });
	sqlite
		.prepare('INSERT INTO users (id, name, email) VALUES (?, ?, ?)')
		.run('user-a', 'User A', 'a@example.com');
	sqlite
		.prepare('INSERT INTO users (id, name, email) VALUES (?, ?, ?)')
		.run('user-b', 'User B', 'b@example.com');
	currentUserId = 'user-a';
});

afterEach(() => sqlite.close());

const theme = (id: string) => getDenizenThemes().find((t) => t.id === id)!;
const threat = (id: string) => getDenizenThreats().find((t) => t.id === id)!;

const bruteDraft = () =>
	seedFromTemplates({ ...createBlankDraft(), name: 'Locust Husk' }, theme('undead'), threat('brute'));

type AnyHandler = (event: {
	request: Request;
	params: Record<string, string>;
}) => Promise<Response>;

function call(handler: unknown, body?: unknown, params: Record<string, string> = {}) {
	return (handler as AnyHandler)({
		request: new Request('http://guild-book.test/api/denizens', {
			method: 'POST',
			...(body !== undefined ? { body: JSON.stringify(body) } : {})
		}),
		params
	});
}

async function expectHttpError(promise: Promise<Response>, status: number) {
	try {
		await promise;
		expect.unreachable(`expected a ${status} error`);
	} catch (err) {
		expect((err as { status?: number }).status).toBe(status);
	}
}

describe('POST /api/denizens', () => {
	it('rejects anonymous saves with 401', async () => {
		currentUserId = null;
		await expectHttpError(call(listHandlers.POST, { draft: bruteDraft() }), 401);
	});

	it('saves a valid draft and lists it', async () => {
		const created = await call(listHandlers.POST, { draft: bruteDraft() });
		expect(created.status).toBe(201);
		const { id } = (await created.json()) as { id: string };

		const listed = await call(listHandlers.GET);
		const rows = (await listed.json()) as Array<{ id: string; name: string; theme: string; threat: string }>;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ id, name: 'Locust Husk', theme: 'undead', threat: 'brute' });
	});

	it('rejects invalid drafts with 400', async () => {
		await expectHttpError(call(listHandlers.POST, { draft: 'nonsense' }), 400);
		await expectHttpError(call(listHandlers.POST, { draft: { ...bruteDraft(), health: '0' } }), 400);
		await expectHttpError(
			call(listHandlers.POST, { draft: { ...bruteDraft(), themeId: 'nonsense' } }),
			400
		);
	});

	it('stores the draft as authoritative — no materialized definition', async () => {
		const created = await call(listHandlers.POST, { draft: bruteDraft() });
		const { id } = (await created.json()) as { id: string };
		const raw = sqlite.prepare('SELECT data FROM denizens WHERE id = ?').get(id) as {
			data: string;
		};
		const stored = JSON.parse(raw.data);
		expect(stored).toEqual(bruteDraft());
		expect('attributes' in stored && 'id' in stored).toBe(false); // no DenizenDefinition fields
	});
});

describe('GET/PUT/DELETE /api/denizens/:id', () => {
	async function save(draft = bruteDraft()) {
		const created = await call(listHandlers.POST, { draft });
		return ((await created.json()) as { id: string }).id;
	}

	it('enforces ownership — another user gets 404', async () => {
		const id = await save();
		currentUserId = 'user-b';
		await expectHttpError(call(itemHandlers.GET, undefined, { id }), 404);
		await expectHttpError(call(itemHandlers.PUT, { draft: bruteDraft() }, { id }), 404);
		await expectHttpError(call(itemHandlers.DELETE, undefined, { id }), 404);
	});

	it('round-trips the draft and sanitizes hand-edited rows on read', async () => {
		const id = await save();
		const fetched = await call(itemHandlers.GET, undefined, { id });
		const row = (await fetched.json()) as { data: unknown };
		expect(row.data).toEqual(bruteDraft());

		// Corrupt the stored blob directly — the API repairs it field by field.
		sqlite
			.prepare('UPDATE denizens SET data = ? WHERE id = ?')
			.run(JSON.stringify({ name: 'Broken', health: 42, notes: 'nope' }), id);
		const repaired = await call(itemHandlers.GET, undefined, { id });
		const repairedRow = (await repaired.json()) as { data: unknown };
		expect(repairedRow.data).toEqual(sanitizeDraft({ name: 'Broken' }));
	});

	it('updates with optimistic concurrency', async () => {
		const id = await save();
		const fetched = await call(itemHandlers.GET, undefined, { id });
		const row = (await fetched.json()) as { updatedAt: string };
		const loadedAt = new Date(row.updatedAt).getTime();

		const renamed = { ...bruteDraft(), name: 'Renamed Husk' };
		const updated = await call(
			itemHandlers.PUT,
			{ draft: renamed, expectedUpdatedAt: loadedAt },
			{ id }
		);
		expect(updated.status).toBe(200);

		// A second write with the stale timestamp is rejected 409.
		const stale = await call(
			itemHandlers.PUT,
			{ draft: renamed, expectedUpdatedAt: loadedAt },
			{ id }
		);
		expect(stale.status).toBe(409);
		const conflict = (await stale.json()) as { currentUpdatedAt: number };
		expect(conflict.currentUpdatedAt).toBeGreaterThan(loadedAt);
	});

	it('accepts a valid dungeon-lord draft with pools', async () => {
		const lord = updatePool(
			seedFromTemplates(
				{ ...createBlankDraft(), name: 'Gilded Horror' },
				theme('sorcerous'),
				threat('dungeon-lord')
			),
			0,
			() => ({ ...createBlankPoolDraft(), name: 'The Crown', health: '6', defense: '3' })
		);
		const id = await save(lord);
		const listed = await call(listHandlers.GET);
		const rows = (await listed.json()) as Array<{ id: string; threat: string }>;
		expect(rows.find((r) => r.id === id)?.threat).toBe('dungeon-lord');
	});

	it('archives on delete and hides archived rows from the list', async () => {
		const id = await save();
		const deleted = await call(itemHandlers.DELETE, undefined, { id });
		expect(deleted.status).toBe(200);

		const listed = await call(listHandlers.GET);
		expect((await listed.json()) as unknown[]).toHaveLength(0);
		// Soft delete: the row still exists, archived.
		const raw = sqlite.prepare('SELECT is_archived FROM denizens WHERE id = ?').get(id) as {
			is_archived: number;
		};
		expect(raw.is_archived).toBe(1);
	});
});
