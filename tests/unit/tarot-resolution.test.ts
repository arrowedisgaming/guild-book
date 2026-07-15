import { describe, expect, it } from 'vitest';
import { resolveTestOfFate, resolveGroupTest } from '$lib/engine/tarot-resolution';
import { getContentPack } from '$lib/server/content/loader';

const config = getContentPack().tarot;

/** A minimal valid input; each test overrides only what it exercises. */
function input(over: Partial<Parameters<typeof resolveTestOfFate>[1]> = {}) {
	return {
		attribute: 2,
		testedSuit: 'cups' as const,
		initialCard: { id: 'cups-x', value: 10, suit: 'cups' as const },
		pushCard: null,
		favor: false,
		disfavor: false,
		resolveSpentForFavor: false,
		...over
	};
}

describe('favor and disfavor', () => {
	// Ch1: each is non-cumulative, and one cancels the other.
	it.each([
		{ favor: false, disfavor: false, modifier: 0 },
		{ favor: true, disfavor: false, modifier: 3 },
		{ favor: false, disfavor: true, modifier: -3 },
		{ favor: true, disfavor: true, modifier: 0 }
	])('reduces favor=$favor disfavor=$disfavor to $modifier', ({ favor, disfavor, modifier }) => {
		expect(resolveTestOfFate(config, input({ favor, disfavor })).modifier).toBe(modifier);
	});

	// Ch1: "You may elect to spend a point of Resolve *prior* to a test of fate
	// in order to gain favor on that test." Resolve is a source of favor.
	it('treats spent Resolve as a source of favor', () => {
		const result = resolveTestOfFate(config, input({ resolveSpentForFavor: true }));
		expect(result.modifier).toBe(3);
		expect(result.favorSources).toEqual(['resolve']);
	});

	it('does not stack Resolve favor with circumstantial favor', () => {
		const result = resolveTestOfFate(config, input({ favor: true, resolveSpentForFavor: true }));
		expect(result.modifier).toBe(3);
		expect(result.favorSources).toEqual(['circumstance', 'resolve']);
	});

	it('lets disfavor cancel Resolve-bought favor', () => {
		expect(
			resolveTestOfFate(config, input({ resolveSpentForFavor: true, disfavor: true })).modifier
		).toBe(0);
	});

	it('reads the modifier from content rather than hardcoding 3', () => {
		const shifted = { ...config, resolution: { ...config.resolution, favorModifier: 5 } };
		expect(resolveTestOfFate(shifted, input({ favor: true })).modifier).toBe(5);
	});
});

describe('thresholds', () => {
	it('fails on a total of 13', () => {
		const r = resolveTestOfFate(config, input({ attribute: 3, initialCard: { id: 'swords-x', value: 10, suit: 'swords' } }));
		expect(r.total).toBe(13);
		expect(r.outcome).toBe('failure');
		expect(r.canPush).toBe(true);
	});

	it('succeeds on a total of 14', () => {
		const r = resolveTestOfFate(config, input({ attribute: 4, initialCard: { id: 'swords-x', value: 10, suit: 'swords' } }));
		expect(r.total).toBe(14);
		expect(r.outcome).toBe('success');
		expect(r.canPush).toBe(false);
	});

	it('great-succeeds on a matching initial suit without a push', () => {
		const r = resolveTestOfFate(config, input({ attribute: 4 }));
		expect(r.outcome).toBe('great-success');
	});

	it('only succeeds on a non-matching initial suit', () => {
		const r = resolveTestOfFate(
			config,
			input({ attribute: 4, initialCard: { id: 'swords-x', value: 10, suit: 'swords' } })
		);
		expect(r.outcome).toBe('success');
	});

	it('counts favor toward the threshold', () => {
		const r = resolveTestOfFate(
			config,
			input({ attribute: 1, initialCard: { id: 'swords-x', value: 10, suit: 'swords' }, favor: true })
		);
		expect(r.total).toBe(14);
		expect(r.outcome).toBe('success');
	});
});

describe('pushing fate', () => {
	// Ch1: "You can never achieve a great success if you push fate."
	it('succeeds after a push but never greatly', () => {
		const r = resolveTestOfFate(
			config,
			input({ attribute: 2, initialCard: { id: 'cups-v', value: 5, suit: 'cups' }, pushCard: { id: 'cups-vii', value: 7, suit: 'cups' } })
		);
		expect(r.total).toBe(14);
		expect(r.outcome).toBe('success');
		expect(r.pushed).toBe(true);
	});

	// Ch1: "If the total result is 13 or less, the test becomes a great failure."
	it('makes a failed push a great failure', () => {
		const r = resolveTestOfFate(
			config,
			input({ attribute: 2, initialCard: { id: 'cups-v', value: 5, suit: 'cups' }, pushCard: { id: 'cups-ii', value: 2, suit: 'cups' } })
		);
		expect(r.total).toBe(9);
		expect(r.outcome).toBe('great-failure');
	});

	it('cannot push a test that already succeeded', () => {
		expect(resolveTestOfFate(config, input({ attribute: 4 })).canPush).toBe(false);
	});
});

describe('the Fool', () => {
	// Ch1: "If you pull the Fool initially … you can push fate as normal."
	it('allows an initial Fool to fail normally and remain pushable', () => {
		const r = resolveTestOfFate(
			config,
			input({ attribute: 4, testedSuit: 'wands', initialCard: { id: 'fool', value: 0 } })
		);
		expect(r.total).toBe(4);
		expect(r.outcome).toBe('failure');
		expect(r.canPush).toBe(true);
	});

	// Ch1: "If you pull the Fool when pushing fate, your result automatically
	// becomes a great failure." Note the total here would otherwise succeed.
	it('makes a Fool on the push an automatic great failure', () => {
		const r = resolveTestOfFate(
			config,
			input({
				attribute: 4,
				testedSuit: 'swords',
				initialCard: { id: 'swords-x', value: 10, suit: 'swords' },
				pushCard: { id: 'fool', value: 0 },
				favor: true,
				resolveSpentForFavor: true
			})
		);
		expect(r.outcome).toBe('great-failure');
		expect(r.automaticGreatFailure).toBe(true);
	});

	it('an initial Fool pushed to 14+ still succeeds', () => {
		const r = resolveTestOfFate(
			config,
			input({ attribute: 4, initialCard: { id: 'fool', value: 0 }, pushCard: { id: 'cups-x', value: 10, suit: 'cups' } })
		);
		expect(r.total).toBe(14);
		expect(r.outcome).toBe('success');
	});

	it('flags a reshuffle whenever the Fool is drawn, on either draw', () => {
		expect(resolveTestOfFate(config, input({ initialCard: { id: 'fool', value: 0 } })).foolDrawn).toBe(true);
		expect(
			resolveTestOfFate(
				config,
				input({ attribute: 1, initialCard: { id: 'cups-ii', value: 2, suit: 'cups' }, pushCard: { id: 'fool', value: 0 } })
			).foolDrawn
		).toBe(true);
		expect(resolveTestOfFate(config, input()).foolDrawn).toBe(false);
	});
});

describe('group tests', () => {
	// Ch1: success=1 hit, great success=2, failure=0, great failure=-1.
	it.each([
		{ outcomes: ['great-success', 'great-success'], hits: 4, id: 'success' },
		{ outcomes: ['great-success', 'success'], hits: 3, id: 'success' },
		{ outcomes: ['success', 'success'], hits: 2, id: 'success' },
		{ outcomes: ['success', 'failure'], hits: 1, id: 'tight-spot' },
		{ outcomes: ['failure', 'failure'], hits: 0, id: 'failure' },
		{ outcomes: ['success', 'great-failure'], hits: 0, id: 'failure' },
		{ outcomes: ['failure', 'great-failure'], hits: -1, id: 'disaster' },
		{ outcomes: ['great-failure', 'great-failure'], hits: -2, id: 'disaster' }
	] as const)('totals $outcomes to $hits hits -> $id', ({ outcomes, hits, id }) => {
		const r = resolveGroupTest(config, [...outcomes]);
		expect(r.hits).toBe(hits);
		expect(r.outcome.id).toBe(id);
	});

	it('reads the hit table from content rather than hardcoding it', () => {
		const shifted = {
			...config,
			resolution: {
				...config.resolution,
				groupOutcomes: config.resolution.groupOutcomes.map((o) =>
					o.id === 'success' ? { ...o, from: 3 } : o.id === 'tight-spot' ? { ...o, to: 2 } : o
				)
			}
		};
		expect(resolveGroupTest(shifted, ['success', 'success']).outcome.id).toBe('tight-spot');
	});
});
