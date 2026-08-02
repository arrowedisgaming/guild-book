import { describe, expect, it } from 'vitest';
import { findFoldedPhrase, foldQueryPhrase } from '$lib/search/find-in-text';

describe('foldQueryPhrase', () => {
	it('strips double quotes (straight and curly), folds case and apostrophes, collapses whitespace', () => {
		expect(foldQueryPhrase('"Dealing  with\ntraps"')).toBe('dealing with traps');
		expect(foldQueryPhrase('“Death’s Door”')).toBe('deaths door');
	});
});

describe('findFoldedPhrase', () => {
	it('finds a phrase inside a single node', () => {
		expect(findFoldedPhrase(['See Dealing with traps below.'], 'dealing with traps')).toEqual([
			{ nodeIndex: 0, start: 4, end: 22 }
		]);
	});

	it('finds a phrase spanning multiple nodes (inline markup splits)', () => {
		const nodes = ['Dealing wi', 'th traps ahead'];
		expect(findFoldedPhrase(nodes, 'dealing with traps')).toEqual([
			{ nodeIndex: 0, start: 0, end: 10 },
			{ nodeIndex: 1, start: 0, end: 8 }
		]);
	});

	it('matches through curly apostrophes in the page text', () => {
		const match = findFoldedPhrase(['Lingering at Death’s Door hurts.'], 'deaths door');
		expect(match).toEqual([{ nodeIndex: 0, start: 13, end: 25 }]);
	});

	it('matches across collapsed whitespace differences', () => {
		expect(findFoldedPhrase(['dealing  with\ntraps'], 'dealing with traps')).toEqual([
			{ nodeIndex: 0, start: 0, end: 19 }
		]);
	});

	it('ignores quotes in the query', () => {
		expect(findFoldedPhrase(['Start dealing with traps now'], '"dealing with traps"')).toEqual([
			{ nodeIndex: 0, start: 6, end: 24 }
		]);
	});

	it('returns null when the phrase is absent or empty', () => {
		expect(findFoldedPhrase(['nothing here'], 'dealing with traps')).toBeNull();
		expect(findFoldedPhrase(['nothing here'], '""')).toBeNull();
	});
});
