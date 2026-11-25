import { describe, expect, it } from 'vitest';
import { fuzzyFilter, fuzzyScore } from '../../src/lib/utils/fuzzy';

const items = ['Rope', 'Shield, Light', 'Shield, Heavy', 'Iron Spikes', 'Crowbar', 'Tinker’s Kit', 'Arrows'];
const find = (query: string) => fuzzyFilter(query, items, (item) => item);

describe('fuzzy matching', () => {
	it('returns everything, in order, for an empty query', () => {
		expect(find('')).toEqual(items);
		expect(find('   ')).toEqual(items);
	});

	it('ranks an exact name first, then prefixes, then letters in order', () => {
		expect(find('rope')[0]).toBe('Rope');
		expect(find('shield, light')[0]).toBe('Shield, Light');
		expect(find('shi')).toEqual(['Shield, Light', 'Shield, Heavy']);
		expect(find('spikes')[0]).toBe('Iron Spikes');
	});

	it('matches scattered letters and ignores case, accents and punctuation', () => {
		expect(find('shl')[0]).toBe('Shield, Light');
		expect(find('TINKERS')[0]).toBe('Tinker’s Kit');
		expect(fuzzyScore('cafe', 'Café au lait')).not.toBeNull();
	});

	it('drops what does not match', () => {
		expect(find('zzz')).toEqual([]);
		expect(fuzzyScore('ropes', 'Rope')).toBeNull();
	});
});
