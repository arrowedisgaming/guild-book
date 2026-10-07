import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from '$lib/server/db/schema';
import { characters, characterVersionClaims } from '$lib/server/db/schema';
import { createBlankCharacter } from '$lib/types/character';
import { updateCharacterSchema } from '$lib/schemas/character.schema';
import type { AppDb } from '$lib/server/db';

const mocks = vi.hoisted(() => ({
	getDb: vi.fn(),
	ensureUser: vi.fn()
}));

vi.mock('$lib/server/db', () => ({ getDb: mocks.getDb }));
vi.mock('$lib/server/auth', () => ({ ensureUser: mocks.ensureUser }));

import { PUT } from '../../src/routes/api/characters/[id]/+server';

describe('character update concurrency API', () => {
	let sqlite: Database.Database;
	let db: AppDb;

	beforeEach(() => {
		sqlite = new Database(':memory:');
		sqlite.pragma('foreign_keys = ON');
		sqlite.exec(`
			CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL);
			CREATE TABLE characters (
				id TEXT PRIMARY KEY NOT NULL,
				user_id TEXT NOT NULL REFERENCES users(id),
				name TEXT NOT NULL DEFAULT '',
				kith TEXT NOT NULL DEFAULT '',
				path TEXT NOT NULL DEFAULT '',
				data TEXT NOT NULL,
				version INTEGER NOT NULL DEFAULT 1,
				life_status TEXT NOT NULL DEFAULT 'alive',
				is_draft INTEGER NOT NULL DEFAULT true,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE character_version_claims (
				id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
				character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
				resulting_version INTEGER NOT NULL,
				mutation_kind TEXT NOT NULL,
				actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
				created_at INTEGER NOT NULL,
				UNIQUE(character_id, resulting_version)
			);
		`);
		sqlite.prepare('INSERT INTO users (id) VALUES (?)').run('user-a');
		sqlite
			.prepare(
				'INSERT INTO characters (id, user_id, data, version, life_status, is_draft, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)'
			)
			.run('character-a', 'user-a', JSON.stringify(createBlankCharacter()), 'alive', 1, 100);
		sqlite
			.prepare(
				'INSERT INTO character_version_claims (character_id, resulting_version, mutation_kind, actor_user_id, created_at) VALUES (?, 1, ?, ?, ?)'
			)
			.run('character-a', 'create', 'user-a', 100);
		db = drizzle(sqlite, { schema });
		mocks.getDb.mockResolvedValue(db);
		mocks.ensureUser.mockResolvedValue('user-a');
	});

	afterEach(() => {
		vi.clearAllMocks();
		sqlite.close();
	});

	it('requires an integer version or the temporary timestamp compatibility field', async () => {
		const character = createBlankCharacter();
		expect(updateCharacterSchema.safeParse({ character }).success).toBe(false);
		expect(updateCharacterSchema.safeParse({ character, expectedVersion: 1 }).success).toBe(true);
		expect(updateCharacterSchema.safeParse({ character, expectedUpdatedAt: 100_000 }).success).toBe(
			true
		);

		await expect(PUT(updateEvent({ character }))).rejects.toMatchObject({ status: 400 });
	});

	it('translates an exact legacy timestamp to the current version and records a claim', async () => {
		const character = { ...createBlankCharacter(), notes: 'legacy winner' };
		const response = await PUT(updateEvent({ character, expectedUpdatedAt: 100_000 }));

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ success: true, version: 2 });

		const stored = await db
			.select({ data: characters.data, version: characters.version })
			.from(characters)
			.where(eq(characters.id, 'character-a'))
			.get();
		expect(stored!.version).toBe(2);
		expect(JSON.parse(stored!.data).notes).toBe('legacy winner');

		const claims = await db
			.select({ version: characterVersionClaims.resultingVersion })
			.from(characterVersionClaims)
			.where(eq(characterVersionClaims.characterId, 'character-a'));
		expect(claims.map((claim) => claim.version)).toEqual([1, 2]);
	});

	it('returns the current version when the compatibility timestamp is stale', async () => {
		const response = await PUT(
			updateEvent({ character: createBlankCharacter(), expectedUpdatedAt: 99_000 })
		);

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			message: 'Adventurer was updated elsewhere — refetch and retry',
			currentVersion: 1
		});
	});

	it('maps a stale integer version to 409 without overwriting the winner', async () => {
		const winner = await PUT(
			updateEvent({
				character: { ...createBlankCharacter(), notes: 'winner' },
				expectedVersion: 1
			})
		);
		expect(winner.status).toBe(200);

		const stale = await PUT(
			updateEvent({
				character: { ...createBlankCharacter(), notes: 'loser' },
				expectedVersion: 1
			})
		);
		expect(stale.status).toBe(409);
		expect(await stale.json()).toEqual({
			message: 'Adventurer was updated elsewhere — refetch and retry',
			currentVersion: 2
		});

		const stored = await db
			.select({ data: characters.data })
			.from(characters)
			.where(eq(characters.id, 'character-a'))
			.get();
		expect(JSON.parse(stored!.data).notes).toBe('winner');
	});
 it('rejects an obsolete schema before defaults can erase XP history', async () => {
  const old = { ...createBlankCharacter(), schemaVersion: 3 };
  const response = await PUT(updateEvent({ character: old, expectedVersion: 1 }));
  expect(response.status).toBe(409);
  expect(((await response.json()) as { message: string }).message).toMatch(/reload/i);
 });
 it('rejects a mismatched XP balance, even on a draft', async () => {
  await expect(PUT(updateEvent({ character: { ...createBlankCharacter(), experience: 99 }, expectedVersion: 1 }))).rejects.toMatchObject({ status: 400 });
 });
 it('preserves anomalous legacy XP during unrelated edits', async () => {
  const legacy = { ...createBlankCharacter(), schemaVersion: 3, experience: -2 };
  await db.update(characters).set({ data: JSON.stringify(legacy) }).where(eq(characters.id, 'character-a'));
  const { migrateCharacterData } = await import('$lib/engine/character-migration');
  const updated = { ...migrateCharacterData(legacy), notes: 'Unrelated note' };
  const response = await PUT(updateEvent({ character: updated, expectedVersion: 1 }));
  expect(response.status).toBe(200);
 });
 it('rejects component slot tampering on draft saves', async () => {
  const character = createBlankCharacter();
  character.equipment.push({ itemId: null, customName: 'Ash', tier: 'impoverished', location: 'pack', packSpace: 0, quantity: 1, notchesTaken: 0, spellComponent: { spellId: null, spellName: '', notes: '' } });
  await expect(PUT(updateEvent({ character, expectedVersion: 1 }))).rejects.toMatchObject({ status: 400 });
 });

 it('allows a documented repair while preserving another legacy talent anomaly', async () => {
  const previous = createBlankCharacter();
  previous.talents = ['acrobat', 'aegis'].map(talentId => ({ talentId, state: 'in-training', source: 'general', sourceLabel: 'Old sheet', at: '', wounded: false, xp: -1, preparedUses: null }));
  await db.update(characters).set({ data: JSON.stringify(previous) }).where(eq(characters.id, 'character-a'));
  const character = structuredClone(previous);
  character.talents[0].xp = 0;
  character.talents[0].preparedUses = 0;
  character.xpLedger.entries.push({ id: 'repair', at: '2026-09-09T12:00:00Z', delta: 0, kind: 'correction', sourceId: 'correction', sourceLabel: 'Correction — Acrobat', reason: 'Repair old sheet', talentId: 'acrobat', talentBefore: { xp: -1, state: 'in-training', preparedUses: null }, talentAfter: { xp: 0, state: 'in-training', preparedUses: 0 } });
  const response = await PUT(updateEvent({ character, expectedVersion: 1 }));
  expect(response.status).toBe(200);
 });
 it('rejects newly introduced talent progress above the mastery threshold', async () => {
  const character = createBlankCharacter();
  character.talents.push({ talentId: 'acrobat', state: 'in-training', source: 'general', sourceLabel: 'Invalid', at: '', wounded: false, xp: 9, preparedUses: 0 });
  await expect(PUT(updateEvent({ character, expectedVersion: 1 }))).rejects.toMatchObject({ status: 400 });
 });

 it('accepts an ordinary balanced XP award without requiring a correction', async () => {
  const character = createBlankCharacter();
  character.experience = 3;
  character.xpLedger.entries.push({ id: 'award', at: '2026-09-09T12:00:00Z', delta: 3, kind: 'award', sourceId: 'quest-accepted', sourceLabel: 'Quest accepted', reason: 'Rescue the bellringer' });
  const response = await PUT(updateEvent({ character, expectedVersion: 1 }));
  expect(response.status).toBe(200);
 });

 it('answers a stale XP write with a recoverable 409, not a 400 history error', async () => {
  // Another device recorded an award first; this client still holds version 1.
  const newer = createBlankCharacter();
  newer.experience = 3;
  newer.xpLedger.entries.push({ id: 'elsewhere', at: '2026-09-09T12:00:00Z', delta: 3, kind: 'award', sourceId: 'quest-accepted', sourceLabel: 'Quest accepted', reason: 'Recorded on another device' });
  await db.update(characters).set({ data: JSON.stringify(newer), version: 2 }).where(eq(characters.id, 'character-a'));
  const stale = createBlankCharacter();
  stale.experience = 1;
  stale.xpLedger.entries.push({ id: 'here', at: '2026-09-09T12:01:00Z', delta: 1, kind: 'award', sourceId: 'contract-completed', sourceLabel: 'Contract completed', reason: 'Recorded here' });
  const response = await PUT(updateEvent({ character: stale, expectedVersion: 1 }));
  expect(response.status).toBe(409);
 });

 it('rejects a hand-crafted award that inflates the real preset amount', async () => {
  const character = createBlankCharacter();
  character.experience = 999;
  character.xpLedger.entries.push({ id: 'forged', at: '2026-09-09T12:00:00Z', delta: 999, kind: 'award', sourceId: 'quest-accepted', sourceLabel: 'Quest accepted', reason: 'Rescue the bellringer' });
  await expect(PUT(updateEvent({ character, expectedVersion: 1 }))).rejects.toMatchObject({ status: 400 });
 });

 it('accepts talent progress marked directly on the sheet', async () => {
  const character = createBlankCharacter();
  character.talents.push({ talentId: 'acrobat', state: 'mastered', source: 'general', sourceLabel: 'Marked on sheet', at: '', wounded: false, xp: 7, preparedUses: 0 });
  const response = await PUT(updateEvent({ character, expectedVersion: 1 }));
  expect(response.status).toBe(200);
 });

 it('rejects a real character-level XP action batch that rewrites earlier ledger history', async () => {
  const withOneAward = createBlankCharacter();
  withOneAward.experience = 3;
  withOneAward.xpLedger.entries.push({ id: 'first', at: '2026-09-09T12:00:00Z', delta: 3, kind: 'award', sourceId: 'quest-accepted', sourceLabel: 'Quest accepted', reason: 'Rescue the bellringer' });
  await db.update(characters).set({ data: JSON.stringify(withOneAward) }).where(eq(characters.id, 'character-a'));
  const tampered = structuredClone(withOneAward);
  tampered.xpLedger.entries[0] = { ...tampered.xpLedger.entries[0], reason: 'A different story entirely' };
  await expect(PUT(updateEvent({ character: tampered, expectedVersion: 1 }))).rejects.toMatchObject({ status: 400 });
 });

});

function updateEvent(body: unknown) {
	return {
		request: new Request('http://localhost/api/characters/character-a', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		}),
		params: { id: 'character-a' }
	} as Parameters<typeof PUT>[0];
}
