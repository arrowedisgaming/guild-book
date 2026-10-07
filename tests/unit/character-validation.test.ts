import { describe, it, expect } from 'vitest';
import { validateFinalCharacter, validateCharacterPlayState } from '$lib/server/validation/character';
import { createBlankCharacter } from '$lib/types/character';
import type { GuildBookCharacterData } from '$lib/types/character';
import { validateExperience } from '$lib/engine/experience';
import { characterDataSchema } from '$lib/schemas/character.schema';

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

describe('validateExperience', () => {
	it('accepts a coherent fresh ledger', () => {
		expect(validateExperience(createBlankCharacter())).toEqual([]);
	});

	it('reports malformed legacy numbers and ledger mismatches separately from structural parsing', () => {
		const c = createBlankCharacter();
		c.experience = -0.5;
		c.xpLedger.openingBalance = -0.5;
		expect(characterDataSchema.safeParse(c).success).toBe(true);
		expect(validateExperience(c).join(' ')).toMatch(/nonnegative safe integer/i);
	});
});

describe('validateCharacterPlayState', () => {
	/** Fractional XP only exists to repair migrated legacy balances. */
	function fractionalLedger(): GuildBookCharacterData {
		const c = createBlankCharacter();
		c.xpLedger.openingBalance = 0.5;
		c.xpLedger.entries.push({ id: 'fix', at: '2026-09-09T12:00:00.000Z', delta: 0.5, kind: 'correction', sourceId: 'correction', sourceLabel: 'Correction', reason: 'Round up' });
		c.experience = 1;
		return c;
	}

	it('rejects fractional XP on a character created natively at the current schema', () => {
		expect(validateCharacterPlayState(fractionalLedger(), undefined, { native: true }).errors.join(' ')).toMatch(/whole numbers/);
	});

	it('still accepts a fractional repair carried in from a migrated legacy draft', () => {
		expect(validateCharacterPlayState(fractionalLedger()).valid).toBe(true);
	});
});

describe('spell component structural validation', () => {
	it('accepts a component with an unavailable spell id and readable snapshot', () => {
		const c = createBlankCharacter();
		c.equipment.push({ itemId: null, customName: 'Ash from the drowned chapel', tier: 'impoverished', packSpace: 1, location: 'pack', quantity: 1, notchesTaken: 0, spellComponent: { spellId: 'missing-spell', spellName: 'Lost Working', notes: '' } });
		expect(characterDataSchema.safeParse(c).success).toBe(true);
	});

	it.each([
		{ customName: ' ', spellComponent: { spellId: null, spellName: '', notes: '' } },
		{ customName: 'Ash', location: 'worn', spellComponent: { spellId: null, spellName: '', notes: '' } },
		{ customName: 'Ash', quantity: 0, spellComponent: { spellId: null, spellName: '', notes: '' } },
		{ customName: 'Ash', spellComponent: { spellId: 'known', spellName: ' ', notes: '' } }
	])('rejects invalid component metadata %#', (overrides) => {
		const c = createBlankCharacter();
		c.equipment.push({ itemId: null, tier: 'impoverished', packSpace: 1, location: 'pack', quantity: 1, notchesTaken: 0, ...overrides } as never);
		expect(characterDataSchema.safeParse(c).success).toBe(false);
	});
});
