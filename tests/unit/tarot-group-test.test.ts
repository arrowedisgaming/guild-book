import { describe, expect, it } from 'vitest';
import { selectGroupTestActors, resolveGroupTest } from '$lib/engine/tarot-group-test';
import { getContentPack } from '$lib/server/content/loader';

const config = getContentPack().tarot;

const roster = (...attrs: number[]) =>
	attrs.map((attribute, i) => ({ id: String.fromCharCode(97 + i), attribute, rosterOrder: i }));

describe('selecting who tests', () => {
	it('picks the most and least qualified', () => {
		const s = selectGroupTestActors(roster(2, 4, 1, 3));
		expect(s.mostQualified.id).toBe('b');
		expect(s.leastQualified.id).toBe('c');
	});

	/**
	 * Ch1: "If there are apparent ties, talk it out to determine who should make
	 * the tests." Ties are a table decision, so the engine proposes a stable
	 * default and reports the tie rather than silently deciding.
	 */
	it('reports a tie for the most qualified instead of deciding silently', () => {
		const s = selectGroupTestActors(roster(4, 4, 1));
		expect(s.mostQualified.id).toBe('a'); // stable: first in roster order
		expect(s.tiedForMost.map((a) => a.id)).toEqual(['a', 'b']);
		expect(s.requiresTableDecision).toBe(true);
	});

	it('reports a tie for the least qualified', () => {
		const s = selectGroupTestActors(roster(4, 1, 1));
		expect(s.leastQualified.id).toBe('b');
		expect(s.tiedForLeast.map((a) => a.id)).toEqual(['b', 'c']);
		expect(s.requiresTableDecision).toBe(true);
	});

	it('reports no table decision when both ends are unambiguous', () => {
		const s = selectGroupTestActors(roster(2, 4, 1));
		expect(s.requiresTableDecision).toBe(false);
		expect(s.tiedForMost).toHaveLength(1);
	});

	it('is stable under roster order, not input order', () => {
		const shuffled = [
			{ id: 'c', attribute: 4, rosterOrder: 2 },
			{ id: 'a', attribute: 4, rosterOrder: 0 },
			{ id: 'b', attribute: 1, rosterOrder: 1 }
		];
		expect(selectGroupTestActors(shuffled).mostQualified.id).toBe('a');
	});

	it('rejects a solo roster', () => {
		expect(() => selectGroupTestActors(roster(3))).toThrow(/at least two distinct/);
	});

	it('rejects duplicate candidate ids as a solo roster', () => {
		expect(() =>
			selectGroupTestActors([
				{ id: 'same', attribute: 4, rosterOrder: 0 },
				{ id: 'same', attribute: 1, rosterOrder: 1 }
			])
		).toThrow(/at least two distinct/);
	});

	it('selects distinct actors when every attribute ties', () => {
		const selection = selectGroupTestActors(roster(3, 3, 3));
		expect(selection.mostQualified.id).not.toBe(selection.leastQualified.id);
		expect(selection.requiresTableDecision).toBe(true);
	});

	it('rejects an empty roster rather than inventing an actor', () => {
		expect(() => selectGroupTestActors([])).toThrow();
	});
});

describe('group outcome', () => {
	it('requires exactly two outcomes', () => {
		expect(() => resolveGroupTest(config, ['success'])).toThrow(/exactly two/);
		expect(() => resolveGroupTest(config, ['success', 'failure', 'success'])).toThrow(/exactly two/);
	});

	it.each([
		{ outcomes: ['great-success', 'great-success'], hits: 4, id: 'success' },
		{ outcomes: ['success', 'success'], hits: 2, id: 'success' },
		{ outcomes: ['success', 'failure'], hits: 1, id: 'tight-spot' },
		{ outcomes: ['failure', 'failure'], hits: 0, id: 'failure' },
		{ outcomes: ['great-failure', 'great-failure'], hits: -2, id: 'disaster' }
	] as const)('totals $outcomes to $hits -> $id', ({ outcomes, hits, id }) => {
		const r = resolveGroupTest(config, [...outcomes]);
		expect(r.hits).toBe(hits);
		expect(r.outcome.id).toBe(id);
	});
});
