import { describe, expect, it } from 'vitest';
import {
	MAX_LANGUAGE_LENGTH,
	addLanguage,
	availableLanguages,
	knowsLanguage,
	normalizeLanguage,
	removeLanguageAt
} from '$lib/character/languages';
import type { NamedEntry } from '$lib/types/content-pack';

const CATALOG: NamedEntry[] = [
	{ id: 'vulgaris', name: 'Vulgaris', description: 'The common tongue.' },
	{ id: 'cant', name: 'Cant', description: 'The language of the lowborn.' },
	{ id: 'vetus', name: 'Vetus', description: 'The dead tongue of the empire.' }
];

describe('normalizeLanguage', () => {
	it('trims and collapses interior whitespace', () => {
		expect(normalizeLanguage('  Old   Vetus ')).toBe('Old Vetus');
	});

	it('caps a runaway paste at the storage limit', () => {
		expect(normalizeLanguage('x'.repeat(500))).toHaveLength(MAX_LANGUAGE_LENGTH);
	});
});

describe('knowsLanguage', () => {
	it('matches regardless of case or stray spacing', () => {
		expect(knowsLanguage(['Cant'], 'cant')).toBe(true);
		expect(knowsLanguage(['Cant'], '  CANT  ')).toBe(true);
	});

	it('does not treat a blank value as known', () => {
		expect(knowsLanguage(['Cant'], '   ')).toBe(false);
	});
});

describe('availableLanguages', () => {
	it('offers only the tongues the adventurer has not learned', () => {
		expect(availableLanguages(['Vulgaris'], CATALOG).map((l) => l.id)).toEqual(['cant', 'vetus']);
	});

	/**
	 * Languages are stored as display names, so a language added by hand and one
	 * picked from the pack are the same entry — typing "vulgaris" must remove
	 * Vulgaris from the dropdown rather than leaving a way to duplicate it.
	 */
	it('hides a pack language that was typed in by hand', () => {
		expect(availableLanguages(['vulgaris'], CATALOG).map((l) => l.id)).toEqual(['cant', 'vetus']);
	});

	it('returns nothing once every pack language is known', () => {
		expect(availableLanguages(['Vulgaris', 'Cant', 'Vetus'], CATALOG)).toEqual([]);
	});
});

describe('addLanguage', () => {
	it('appends a normalized entry', () => {
		expect(addLanguage(['Vulgaris'], '  Thieves  Cant ')).toEqual(['Vulgaris', 'Thieves Cant']);
	});

	it('returns the original list untouched for a duplicate', () => {
		const known = ['Vulgaris'];
		expect(addLanguage(known, 'vulgaris')).toBe(known);
	});

	it('returns the original list untouched for a blank value', () => {
		const known = ['Vulgaris'];
		expect(addLanguage(known, '   ')).toBe(known);
	});

	it('does not mutate the list it was given', () => {
		const known = ['Vulgaris'];
		addLanguage(known, 'Cant');
		expect(known).toEqual(['Vulgaris']);
	});
});

describe('removeLanguageAt', () => {
	it('drops the entry at the index', () => {
		expect(removeLanguageAt(['Vulgaris', 'Cant', 'Vetus'], 1)).toEqual(['Vulgaris', 'Vetus']);
	});

	it('leaves the list alone for an out-of-range index', () => {
		const known = ['Vulgaris'];
		expect(removeLanguageAt(known, 4)).toBe(known);
		expect(removeLanguageAt(known, -1)).toBe(known);
	});
});
