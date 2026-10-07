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

		expect(migrated.schemaVersion).toBe(CHARACTER_SCHEMA_VERSION);
		expect(migrated.life).toEqual({ status: 'alive' });
	});

	it('migrates v3 XP into an opening balance without inventing history or prepared uses', () => {
		const raw = {
			...createBlankCharacter(),
			schemaVersion: 3,
			experience: 5,
			xpLedger: undefined,
			talents: [{ talentId: 't', state: 'in-training', source: 'path', sourceLabel: 'Path', at: '', wounded: false, xp: 4 }]
		};
		const migrated = migrateCharacterData(raw);
		expect(migrated.experience).toBe(5);
		expect(migrated.xpLedger).toEqual({ openingBalance: 5, entries: [] });
		expect(migrated.talents[0]).toMatchObject({ xp: 4, preparedUses: null });
		expect(migrateCharacterData(migrated)).toEqual(migrated);
	});

	it.each([[-2], [2.5]])('preserves anomalous legacy balance %s for explicit correction', (experience) => {
		const migrated = migrateCharacterData({ ...createBlankCharacter(), schemaVersion: 3, experience, xpLedger: undefined });
		expect(migrated.experience).toBe(experience);
		expect(migrated.xpLedger.openingBalance).toBe(experience);
	});

	/**
	 * Unlike talents/equipment/bonds, a v5 document's xpLedger was passed
	 * through with only a `?? default` guard — present-but-malformed shapes
	 * skipped every check and reached `.reduce`/`.some` calls downstream.
	 */
	it.each([
		['a bare object', {}],
		['entries as a non-array', { openingBalance: 3, entries: 'not-an-array' }],
		['a non-object', 'not-a-ledger'],
		['null', null]
	])('falls back cleanly instead of crashing when xpLedger is malformed (%s)', (_label, xpLedger) => {
		const raw = { ...createBlankCharacter(), schemaVersion: 5, experience: 3, xpLedger };
		const migrated = migrateCharacterData(raw);
		expect(migrated.xpLedger).toEqual({ openingBalance: 3, entries: [] });
		expect(() => migrated.xpLedger.entries.reduce((sum, e) => sum + e.delta, 0)).not.toThrow();
	});

	it('keeps a valid opening balance and drops only the entries that are not structurally an XP entry', () => {
		const goodEntry = { id: 'a', at: '2026-01-01T00:00:00.000Z', delta: 3, kind: 'award', sourceId: 'quest', sourceLabel: 'Quest', reason: 'r' };
		const raw = {
			...createBlankCharacter(),
			schemaVersion: 5,
			experience: 3,
			xpLedger: { openingBalance: 0, entries: [goodEntry, { garbage: true }, null, 'not-an-entry', 42] }
		};
		const migrated = migrateCharacterData(raw);
		expect(migrated.xpLedger).toEqual({ openingBalance: 0, entries: [goodEntry] });
	});
});
