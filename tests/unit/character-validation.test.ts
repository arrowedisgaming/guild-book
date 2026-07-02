import { describe, it, expect } from 'vitest';
import { validateFinalCharacter } from '$lib/server/validation/character';
import { createBlankCharacter } from '$lib/types/character';
import type { GuildBookCharacterData } from '$lib/types/character';

/** A finished Path-of-Swords adventurer: swords=4 (path suit), then 3/2/1. */
function finishedSwordsAdventurer(): GuildBookCharacterData {
	const c = createBlankCharacter();
	c.name = 'Test Knight';
	c.kithId = 'human';
	c.kinId = 'human-noble-house';
	c.pathId = 'path-of-swords';
	c.attributes.swords.value = 4;
	c.attributes.pentacles.value = 3;
	c.attributes.cups.value = 2;
	c.attributes.wands.value = 1;
	c.isDraft = false;
	return c;
}

describe('validateFinalCharacter', () => {
	it('accepts a correctly-built adventurer', () => {
		const result = validateFinalCharacter(finishedSwordsAdventurer());
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it('rejects a blank adventurer with actionable errors', () => {
		const result = validateFinalCharacter(createBlankCharacter());
		expect(result.valid).toBe(false);
		expect(result.errors.join(' ')).toMatch(/kith/i);
		expect(result.errors.join(' ')).toMatch(/path/i);
	});

	it('rejects an off-suit highest attribute', () => {
		const c = finishedSwordsAdventurer();
		// Path of Swords but the 4 is on Wands — illegal.
		c.attributes.swords.value = 1;
		c.attributes.wands.value = 4;
		const result = validateFinalCharacter(c);
		expect(result.valid).toBe(false);
		expect(result.errors.join(' ')).toMatch(/highest attribute must be swords/i);
	});

	it('rejects a broken attribute spread', () => {
		const c = finishedSwordsAdventurer();
		c.attributes.pentacles.value = 4; // now two 4s, not 4/3/2/1
		const result = validateFinalCharacter(c);
		expect(result.valid).toBe(false);
		expect(result.errors.join(' ')).toMatch(/spread/i);
	});
});
