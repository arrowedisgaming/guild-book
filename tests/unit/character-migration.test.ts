import { describe, it, expect } from 'vitest';
import { migrateCharacterData } from '$lib/engine/character-migration';
import { CHARACTER_SCHEMA_VERSION, createBlankCharacter } from '$lib/types/character';
import { characterDataSchema } from '$lib/schemas/character.schema';
import { SUIT_IDS } from '$lib/types/common';

describe('migrateCharacterData', () => {
	it('turns junk into a schema-valid blank adventurer', () => {
		for (const junk of [null, undefined, 42, 'nope', {}]) {
			const migrated = migrateCharacterData(junk);
			expect(characterDataSchema.safeParse(migrated).success).toBe(true);
			expect(Object.keys(migrated.attributes).sort()).toEqual([...SUIT_IDS].sort());
		}
	});

	it('preserves stored choices and fills missing fields', () => {
		const stored = {
			name: 'Phynn',
			pathId: 'path-of-pentacles',
			attributes: { pentacles: { value: 4, sources: [] } }
			// everything else missing
		};
		const migrated = migrateCharacterData(stored);
		expect(migrated.name).toBe('Phynn');
		expect(migrated.pathId).toBe('path-of-pentacles');
		expect(migrated.attributes.pentacles.value).toBe(4);
		// missing suit backfilled
		expect(migrated.attributes.swords).toEqual({ value: 0, sources: [] });
		// nested defaults present
		expect(migrated.resolve).toEqual({ current: 4, max: 4 });
		expect(migrated.arete.triggersMet).toEqual([false, false, false]);
	});

	it('always stamps the current schema version and system', () => {
		const migrated = migrateCharacterData({ schemaVersion: 0, system: 'other' });
		expect(migrated.schemaVersion).toBe(CHARACTER_SCHEMA_VERSION);
		expect(migrated.system).toBe('hmtw');
	});

	it('migrates a v2 adventurer to an alive v3 life record', () => {
		const raw = { ...createBlankCharacter(), schemaVersion: 2 } as Record<string, unknown>;
		delete raw.life;

		const migrated = migrateCharacterData(raw);

		expect(migrated.schemaVersion).toBe(3);
		expect(migrated.life).toEqual({ status: 'alive' });
	});
});
