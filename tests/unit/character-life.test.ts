import { describe, expect, it } from 'vitest';
import { migrateCharacterData } from '$lib/engine/character-migration';
import { createBlankCharacter } from '$lib/types/character';
import { characters, characterVersionClaims } from '$lib/server/db/schema';

describe('character life migration', () => {
	it('preserves a valid dead life record', () => {
		const life = {
			status: 'dead' as const,
			diedAt: '2026-07-15T12:00:00.000Z',
			campaignId: 'campaign-a',
			sessionId: 'session-a',
			markedByUserId: 'user-a'
		};

		expect(migrateCharacterData({ ...createBlankCharacter(), schemaVersion: 3, life }).life).toEqual(
			life
		);
	});

	it.each([
		{ status: 'dead' },
		{ status: 'dead', diedAt: '2026-07-15T12:00:00.000Z' },
		{
			status: 'dead',
			diedAt: '2026-07-15T12:00:00.000Z',
			markedByUserId: ''
		},
		{ status: 'unknown', diedAt: '2026-07-15T12:00:00.000Z', markedByUserId: 'user-a' },
		null
	])('normalizes malformed life metadata to alive: %j', (life) => {
		expect(migrateCharacterData({ ...createBlankCharacter(), schemaVersion: 3, life }).life).toEqual({
			status: 'alive'
		});
	});
});

describe('character persistence life and version fields', () => {
	it('exposes the integer version, life status, and claim audit columns', () => {
		expect(characters.version.name).toBe('version');
		expect(characters.lifeStatus.name).toBe('life_status');
		expect(characterVersionClaims.characterId.name).toBe('character_id');
		expect(characterVersionClaims.resultingVersion.name).toBe('resulting_version');
		expect(characterVersionClaims.mutationKind.name).toBe('mutation_kind');
	});
});
