import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from '$lib/server/db/schema';
import { characters, characterVersionClaims } from '$lib/server/db/schema';
import { createBlankCharacter } from '$lib/types/character';
import {
	createCharacterWithVersionClaim,
	mutateCharacterMetadata,
	saveWholeCharacter
} from '$lib/server/character/versioned-write';
import type { AppDb } from '$lib/server/db';

describe('saveWholeCharacter', () => {
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
				is_archived INTEGER NOT NULL DEFAULT false,
				share_id TEXT,
				is_public INTEGER NOT NULL DEFAULT false,
				created_at INTEGER NOT NULL DEFAULT 0,
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
	});

	afterEach(() => sqlite.close());

	it('accepts one expected-version update and rejects a stale overwrite', async () => {
		const base = createBlankCharacter();
		const first = await saveWholeCharacter(db, {
			characterId: 'character-a',
			ownerUserId: 'user-a',
			actorUserId: 'user-a',
			expectedVersion: 1,
			data: { ...base, notes: 'winner' }
		});

		expect(first).toMatchObject({ ok: true, version: 2 });
		if (first.ok) expect(first.updatedAt).toBeInstanceOf(Date);

		const stale = await saveWholeCharacter(db, {
			characterId: 'character-a',
			ownerUserId: 'user-a',
			actorUserId: 'user-a',
			expectedVersion: 1,
			data: { ...base, notes: 'loser' }
		});

		expect(stale).toEqual({ ok: false, reason: 'version-conflict', currentVersion: 2 });
		const stored = await db
			.select({ data: characters.data, version: characters.version })
			.from(characters)
			.where(eq(characters.id, 'character-a'))
			.get();
		expect(JSON.parse(stored!.data).notes).toBe('winner');
		expect(stored!.version).toBe(2);

		const claims = await db
			.select({ version: characterVersionClaims.resultingVersion })
			.from(characterVersionClaims)
			.where(eq(characterVersionClaims.characterId, 'character-a'));
		expect(claims.map((claim) => claim.version)).toEqual([1, 2]);
	});

	it('creates version 1 and its claim atomically', async () => {
		const character = { ...createBlankCharacter(), name: 'New Adventurer' };

		const created = await createCharacterWithVersionClaim(db, {
			characterId: 'character-b',
			ownerUserId: 'user-a',
			actorUserId: 'user-a',
			data: character,
			createdAt: new Date(200_000)
		});

		expect(created).toEqual({ version: 1, updatedAt: new Date(200_000) });
		const stored = await db
			.select({ version: characters.version, name: characters.name })
			.from(characters)
			.where(eq(characters.id, 'character-b'))
			.get();
		expect(stored).toEqual({ version: 1, name: 'New Adventurer' });
		const claim = await db
			.select({ version: characterVersionClaims.resultingVersion })
			.from(characterVersionClaims)
			.where(eq(characterVersionClaims.characterId, 'character-b'))
			.get();
		expect(claim).toEqual({ version: 1 });
	});

	it('claims a new version for a narrow metadata mutation', async () => {
		const result = await mutateCharacterMetadata(db, {
			characterId: 'character-a',
			ownerUserId: 'user-a',
			actorUserId: 'user-a',
			expectedVersion: 1,
			mutation: { kind: 'archive' }
		});

		expect(result).toMatchObject({ ok: true, version: 2 });
		const stored = await db
			.select({ version: characters.version, isArchived: characters.isArchived })
			.from(characters)
			.where(eq(characters.id, 'character-a'))
			.get();
		expect(stored).toEqual({ version: 2, isArchived: true });
		const claim = await db
			.select({ kind: characterVersionClaims.mutationKind })
			.from(characterVersionClaims)
			.where(eq(characterVersionClaims.resultingVersion, 2))
			.get();
		expect(claim).toEqual({ kind: 'archive' });
	});
});
