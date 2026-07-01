import { describe, it, expect } from 'vitest';
import { createBlankCharacter, CHARACTER_SCHEMA_VERSION } from '$lib/types/character';
import { characterDataSchema } from '$lib/schemas/character.schema';
import { SUIT_IDS } from '$lib/types/common';

describe('createBlankCharacter', () => {
	it('produces a schema-valid blank adventurer', () => {
		const blank = createBlankCharacter();
		const result = characterDataSchema.safeParse(blank);
		expect(result.success).toBe(true);
	});

	it('starts as a draft at the current schema version', () => {
		const blank = createBlankCharacter();
		expect(blank.isDraft).toBe(true);
		expect(blank.schemaVersion).toBe(CHARACTER_SCHEMA_VERSION);
		expect(blank.wizardStep).toBe(0);
	});

	it('has all four suit-attributes and full starting Resolve', () => {
		const blank = createBlankCharacter();
		expect(Object.keys(blank.attributes).sort()).toEqual([...SUIT_IDS].sort());
		expect(blank.resolve).toEqual({ current: 4, max: 4 });
		expect(blank.motifs).toEqual([]);
		expect(blank.arete.triggersMet).toEqual([false, false, false]);
	});
});
