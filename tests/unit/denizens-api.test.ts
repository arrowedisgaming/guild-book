/**
 * Handler tests for /api/denizens against an in-memory better-sqlite3 drizzle
 * DB (the auth-lifecycle pattern), covering ownership, the anonymous-401
 * path, validation, sanitize-on-read, archived-row discipline, the integer
 * version claim, and the request-size / per-user ceilings.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { error } from '@sveltejs/kit';
import type { AppDb } from '$lib/server/db';
import * as schema from '$lib/server/db/schema';
import {
	createBlankDraft,
	createBlankPoolDraft,
	sanitizeDraft,
	seedFromTemplates,
	seedPersonFromTheme,
	updatePool
} from '$lib/engine/denizen-builder';
import {
	getDenizenPersonRules,
	getDenizenThemes,
	getDenizenThreats
} from '$lib/server/content/loader';
import { MAX_DENIZENS_PER_USER } from '$lib/schemas/denizen.schema';

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

// Every migration, in order — the test DB must not silently diverge from the
// production schema the moment a mid-series migration touches these tables.
const migrationsDir = fileURLToPath(new URL('../../src/lib/server/db/migrations', import.meta.url));
const migrations = readdirSync(migrationsDir)
	.filter((file) => file.endsWith('.sql'))
	.sort()
	.map((file) => readFileSync(`${migrationsDir}/${file}`, 'utf8'));

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

const personDraft = () =>
	seedPersonFromTheme(
		{ ...createBlankDraft(), name: 'Odo the Cannibal' },
		theme('man'),
		getDenizenPersonRules()
	);

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
		const { id, version } = (await created.json()) as { id: string; version: number };
		expect(version).toBe(1);

		const listed = await call(listHandlers.GET);
		const rows = (await listed.json()) as Array<{ id: string; name: string; theme: string; threat: string }>;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ id, name: 'Locust Husk', theme: 'undead', threat: 'brute' });
	});

	it('saves a person draft — no threat, threat column empty', async () => {
		const created = await call(listHandlers.POST, { draft: personDraft() });
		expect(created.status).toBe(201);
		const listed = await call(listHandlers.GET);
		const rows = (await listed.json()) as Array<{ name: string; theme: string; threat: string }>;
		expect(rows[0]).toMatchObject({ name: 'Odo the Cannibal', theme: 'man', threat: '' });
	});

	it('falls back to "Unnamed Denizen" for a blank name', async () => {
		const created = await call(listHandlers.POST, { draft: { ...bruteDraft(), name: '   ' } });
		expect(created.status).toBe(201);
		const listed = await call(listHandlers.GET);
		const rows = (await listed.json()) as Array<{ name: string }>;
		expect(rows[0].name).toBe('Unnamed Denizen');
	});

	it('rejects invalid drafts with 400', async () => {
		await expectHttpError(call(listHandlers.POST, { draft: 'nonsense' }), 400);
		await expectHttpError(call(listHandlers.POST, { draft: { ...bruteDraft(), health: '0' } }), 400);
		await expectHttpError(
			call(listHandlers.POST, { draft: { ...bruteDraft(), themeId: 'nonsense' } }),
			400
		);
	});

	it('refuses an oversized request body outright — junk keys cannot ride along', async () => {
		await expectHttpError(
			call(listHandlers.POST, { draft: bruteDraft(), junk: 'x'.repeat(200_000) }),
			413
		);
	});

	it('enforces the per-user ceiling, archived rows included', async () => {
		const insert = sqlite.prepare(
			`INSERT INTO denizens (id, user_id, name, theme, threat, data, version, is_archived, created_at, updated_at)
			 VALUES (?, 'user-a', 'Filler', '', '', '{}', 1, ?, 0, 0)`
		);
		for (let i = 0; i < MAX_DENIZENS_PER_USER; i += 1) {
			insert.run(`filler-${i}`, i % 2);
		}
		await expectHttpError(call(listHandlers.POST, { draft: bruteDraft() }), 400);

		// Another user is unaffected by user-a's hoard.
		currentUserId = 'user-b';
		expect((await call(listHandlers.POST, { draft: bruteDraft() })).status).toBe(201);
	});

	it('stores the draft as authoritative — no materialized definition', async () => {
		const created = await call(listHandlers.POST, { draft: bruteDraft() });
		const { id } = (await created.json()) as { id: string };
		const raw = sqlite.prepare('SELECT data FROM denizens WHERE id = ?').get(id) as {
			data: string;
		};
		const stored = JSON.parse(raw.data);
		expect(stored).toEqual(bruteDraft());
		// Exactly the draft's keys — a DenizenDefinition would carry id/theme/etc.
		expect(Object.keys(stored).sort()).toEqual(Object.keys(createBlankDraft()).sort());
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
		await expectHttpError(
			call(itemHandlers.PUT, { draft: bruteDraft(), expectedVersion: 1 }, { id }),
			404
		);
		await expectHttpError(call(itemHandlers.DELETE, undefined, { id }), 404);
	});

	it('returns a curated projection — no internal columns', async () => {
		const id = await save();
		const fetched = await call(itemHandlers.GET, undefined, { id });
		const row = (await fetched.json()) as Record<string, unknown>;
		expect(Object.keys(row).sort()).toEqual(
			['createdAt', 'data', 'id', 'name', 'theme', 'threat', 'updatedAt', 'version'].sort()
		);
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

	it('updates under the version claim; a stale claim gets 409 + currentVersion', async () => {
		const id = await save();

		const renamed = { ...bruteDraft(), name: 'Renamed Husk' };
		const updated = await call(
			itemHandlers.PUT,
			{ draft: renamed, expectedVersion: 1 },
			{ id }
		);
		expect(updated.status).toBe(200);
		expect(((await updated.json()) as { version: number }).version).toBe(2);

		// A second write with the stale claim is rejected atomically.
		const stale = await call(itemHandlers.PUT, { draft: renamed, expectedVersion: 1 }, { id });
		expect(stale.status).toBe(409);
		expect(((await stale.json()) as { currentVersion: number }).currentVersion).toBe(2);

		// Retrying with the current claim succeeds.
		const retried = await call(itemHandlers.PUT, { draft: renamed, expectedVersion: 2 }, { id });
		expect(retried.status).toBe(200);
	});

	it('requires the version claim on PUT', async () => {
		const id = await save();
		await expectHttpError(call(itemHandlers.PUT, { draft: bruteDraft() }, { id }), 400);
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

	it('treats an archived row as gone everywhere — GET, PUT, and DELETE all 404', async () => {
		const id = await save();
		await call(itemHandlers.DELETE, undefined, { id });

		await expectHttpError(call(itemHandlers.GET, undefined, { id }), 404);
		await expectHttpError(
			call(itemHandlers.PUT, { draft: bruteDraft(), expectedVersion: 1 }, { id }),
			404
		);
		await expectHttpError(call(itemHandlers.DELETE, undefined, { id }), 404);
	});
});
