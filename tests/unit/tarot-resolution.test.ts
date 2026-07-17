import { describe, expect, it } from 'vitest';
import { resolveTestOfFate } from '$lib/engine/tarot-resolution';
import { getContentPack } from '$lib/server/content/loader';

const config = getContentPack().tarot;

/** A minimal valid input; each test overrides only what it exercises. */
function input(over: Partial<Parameters<typeof resolveTestOfFate>[1]> = {}) {
	return {
		attribute: 2,
		testedSuit: 'cups' as const,
		initialCard: { id: 'cups-x', value: 10, suit: 'cups' as const, origin: 'test-draw' as const },
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
		const r = resolveTestOfFate(config, input({ attribute: 3, initialCard: { id: 'swords-x', value: 10, suit: 'swords', origin: 'test-draw' } }));
		expect(r.total).toBe(13);
		expect(r.outcome).toBe('failure');
		expect(r.canPush).toBe(true);
	});

	it('succeeds on a total of 14', () => {
		const r = resolveTestOfFate(config, input({ attribute: 4, initialCard: { id: 'swords-x', value: 10, suit: 'swords', origin: 'test-draw' } }));
		expect(r.total).toBe(14);
		expect(r.outcome).toBe('success');
		expect(r.canPush).toBe(false);
	});

	it('great-succeeds on a matching initial suit without a push', () => {
		const r = resolveTestOfFate(config, input({ attribute: 4 }));
		expect(r.outcome).toBe('great-success');
	});

	it('does not great-succeed with a matching card supplied by another source', () => {
		const result = resolveTestOfFate(
			config,
			input({
				attribute: 4,
				testedSuit: 'swords',
				initialCard: { id: 'swords-x', value: 10, suit: 'swords', origin: 'supplied' }
			})
		);
		expect(result.outcome).toBe('success');
		expect(result.initialDrawMatchedTestedSuit).toBe(false);
	});

	it('still great-succeeds with a genuine matching initial test draw', () => {
		const result = resolveTestOfFate(
			config,
			input({
				attribute: 4,
				testedSuit: 'swords',
				initialCard: { id: 'swords-x', value: 10, suit: 'swords', origin: 'test-draw' }
			})
		);
		expect(result.outcome).toBe('great-success');
	});

	it('only succeeds on a non-matching initial suit', () => {
		const r = resolveTestOfFate(
			config,
			input({ attribute: 4, initialCard: { id: 'swords-x', value: 10, suit: 'swords', origin: 'test-draw' } })
		);
		expect(r.outcome).toBe('success');
	});

	it('counts favor toward the threshold', () => {
		const r = resolveTestOfFate(
			config,
			input({ attribute: 1, initialCard: { id: 'swords-x', value: 10, suit: 'swords', origin: 'test-draw' }, favor: true })
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
			input({ attribute: 2, initialCard: { id: 'cups-v', value: 5, suit: 'cups', origin: 'test-draw' }, pushCard: { id: 'cups-vii', value: 7, suit: 'cups', origin: 'test-draw' } })
		);
		expect(r.total).toBe(14);
		expect(r.outcome).toBe('success');
		expect(r.pushed).toBe(true);
	});

	// Ch1: "If the total result is 13 or less, the test becomes a great failure."
	it('makes a failed push a great failure', () => {
		const r = resolveTestOfFate(
			config,
			input({ attribute: 2, initialCard: { id: 'cups-v', value: 5, suit: 'cups', origin: 'test-draw' }, pushCard: { id: 'cups-ii', value: 2, suit: 'cups', origin: 'test-draw' } })
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
			input({ attribute: 4, testedSuit: 'wands', initialCard: { id: 'fool', value: 0, origin: 'test-draw' } })
		);
		expect(r.total).toBe(4);
		expect(r.outcome).toBe('failure');
		expect(r.canPush).toBe(true);
	});

	// Ch1: "If you pull the Fool when pushing fate, your result automatically
	// becomes a great failure."
	//
	// The initial draw must genuinely fail, or the push itself is illegal. An
	// earlier version of this test pushed a 17 — an initial success — and only
	// passed because the engine did not yet reject that.
	it('makes a Fool on the push an automatic great failure', () => {
		const r = resolveTestOfFate(
			config,
			input({
				attribute: 4,
				testedSuit: 'swords',
				initialCard: { id: 'swords-ii', value: 2, suit: 'swords', origin: 'test-draw' },
				pushCard: { id: 'fool', value: 0, origin: 'test-draw' },
				favor: true,
				resolveSpentForFavor: true
			})
		);
		// 4 + 2 + 3 favor = 9 → a real failure, so the push is legal. The Fool
		// then overrides the total entirely.
		expect(r.total).toBe(9);
		expect(r.outcome).toBe('great-failure');
		expect(r.automaticGreatFailure).toBe(true);
	});

	it('an initial Fool pushed to 14+ still succeeds', () => {
		const r = resolveTestOfFate(
			config,
			input({ attribute: 4, initialCard: { id: 'fool', value: 0, origin: 'test-draw' }, pushCard: { id: 'cups-x', value: 10, suit: 'cups', origin: 'test-draw' } })
		);
		expect(r.total).toBe(14);
		expect(r.outcome).toBe('success');
	});

	it('flags a reshuffle whenever the Fool is drawn, on either draw', () => {
		expect(resolveTestOfFate(config, input({ initialCard: { id: 'fool', value: 0, origin: 'test-draw' } })).foolDrawn).toBe(true);
		expect(
			resolveTestOfFate(
				config,
				input({ attribute: 1, initialCard: { id: 'cups-ii', value: 2, suit: 'cups', origin: 'test-draw' }, pushCard: { id: 'fool', value: 0, origin: 'test-draw' } })
			).foolDrawn
		).toBe(true);
		expect(resolveTestOfFate(config, input()).foolDrawn).toBe(false);
	});

	it('does not reshuffle for a Fool supplied instead of drawn', () => {
		const result = resolveTestOfFate(
			config,
			input({ initialCard: { id: 'fool', value: 0, origin: 'supplied' } })
		);
		expect(result.foolDrawn).toBe(false);
	});

	it('does not mark a supplied push Fool as an automatic great failure', () => {
		const result = resolveTestOfFate(
			config,
			input({
				attribute: 2,
				initialCard: { id: 'cups-v', value: 5, suit: 'cups', origin: 'test-draw' },
				pushCard: { id: 'fool', value: 0, origin: 'supplied' }
			})
		);
		expect(result.outcome).toBe('great-failure');
		expect(result.automaticGreatFailure).toBe(false);
		expect(result.foolDrawn).toBe(false);
	});
});

describe('push legality', () => {
	/**
	 * Ch1: "If the result of the test is a failure, the player may opt to push
	 * fate." canPush is an output hint for the UI and cannot guard a caller that
	 * ignores it, so the engine rejects an illegal push rather than resolving it.
	 */
	it('rejects a push when the initial draw already succeeded', () => {
		expect(() =>
			resolveTestOfFate(
				config,
				input({
					attribute: 4,
					initialCard: { id: 'cups-x', value: 10, suit: 'cups', origin: 'test-draw' },
					pushCard: { id: 'cups-ii', value: 2, suit: 'cups', origin: 'test-draw' }
				})
			)
		).toThrow(/illegal push/);
	});

	it('rejects pushing a success into a Fool great failure', () => {
		expect(() =>
			resolveTestOfFate(
				config,
				input({
					attribute: 4,
					initialCard: { id: 'cups-x', value: 10, suit: 'cups', origin: 'test-draw' },
					pushCard: { id: 'fool', value: 0, origin: 'test-draw' }
				})
			)
		).toThrow(/illegal push/);
	});

	it('allows a push when favor was not enough to succeed', () => {
		const r = resolveTestOfFate(
			config,
			input({
				attribute: 1,
				initialCard: { id: 'cups-v', value: 5, suit: 'cups', origin: 'test-draw' },
				favor: true,
				pushCard: { id: 'cups-ii', value: 2, suit: 'cups', origin: 'test-draw' }
			})
		);
		expect(r.total).toBe(11);
		expect(r.outcome).toBe('great-failure');
	});

	it('counts the modifier when judging push legality', () => {
		// 10 + 1 = 11 fails alone, but favor makes it 14 — so the push is illegal.
		expect(() =>
			resolveTestOfFate(
				config,
				input({
					attribute: 1,
					initialCard: { id: 'cups-x', value: 10, suit: 'cups', origin: 'test-draw' },
					favor: true,
					pushCard: { id: 'cups-ii', value: 2, suit: 'cups', origin: 'test-draw' }
				})
			)
		).toThrow(/illegal push/);
	});
});
