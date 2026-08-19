import { describe, expect, it } from 'vitest';
import { bondChargeLines, findBondType, isCustomBondText } from '$lib/character/bonds';
import { getBondTypes } from '$lib/server/content/loader';
import type { BondTypeDefinition } from '$lib/types/content-pack';

const TYPES: BondTypeDefinition[] = [
	{
		id: 'ally',
		label: 'Ally',
		description: 'The default Bond.',
		examples: 'Wash and Kaylee',
		charge: ['Charge this Bond when you make your ally laugh.']
	},
	{
		id: 'mentor-mentee',
		label: 'Mentor/Mentee',
		description: 'One teaches, one learns.',
		examples: 'Luke and Yoda',
		charge: ['Mentees charge when advice is given.', 'Mentors charge when advice is followed.']
	}
];

describe('findBondType', () => {
	it('resolves a bond by the label the wizard stored', () => {
		expect(findBondType(TYPES, 'Mentor/Mentee')?.id).toBe('mentor-mentee');
	});

	it('tolerates the casing and padding a hand-edited sheet can carry', () => {
		expect(findBondType(TYPES, '  ally ')?.id).toBe('ally');
	});

	it('returns null for a bond the book never named', () => {
		expect(findBondType(TYPES, 'drinking buddies')).toBeNull();
	});

	it('returns null for an unset bond', () => {
		expect(findBondType(TYPES, '   ')).toBeNull();
	});
});

describe('bondChargeLines', () => {
	it('gives every charge condition a two-sided bond carries', () => {
		expect(bondChargeLines(TYPES, 'Mentor/Mentee')).toHaveLength(2);
	});

	it('gives nothing for a bond with no pack type — there is nothing to quote', () => {
		expect(bondChargeLines(TYPES, 'drinking buddies')).toEqual([]);
		expect(bondChargeLines(TYPES, '')).toEqual([]);
	});
});

describe('isCustomBondText', () => {
	it('is true only for text outside the pack types', () => {
		expect(isCustomBondText(TYPES, 'drinking buddies')).toBe(true);
		expect(isCustomBondText(TYPES, 'Ally')).toBe(false);
		expect(isCustomBondText(TYPES, '')).toBe(false);
	});
});

/**
 * The lookup is by label because that is what a Bond stores — `bonds.json`
 * guarantees labels are unique, and this is the test that fails if a future
 * pack edit ever breaks that guarantee for the shipped content.
 */
describe('the shipped bond types', () => {
	it('resolve by label and every one of them says how to charge it', () => {
		const shipped = getBondTypes();
		for (const type of shipped) {
			expect(findBondType(shipped, type.label)).toBe(type);
			expect(bondChargeLines(shipped, type.label).length).toBeGreaterThan(0);
		}
	});
});
