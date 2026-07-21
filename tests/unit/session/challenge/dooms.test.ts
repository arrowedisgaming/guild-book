import { describe, expect, it } from 'vitest';
import { cardMatchesDoomPredicate, majorCardFrom, type MajorCard } from '$lib/engine/session/procedures/challenge/dooms';
import { makeRichSessionCatalogFixture } from '../../../fixtures/session';

describe('Doom-tier predicates (O2 — never hardcode 14/15)', () => {
	describe('cardMatchesDoomPredicate', () => {
		const lesser: MajorCard = { doomTier: 'lesser', valueParity: 'odd' };
		const greater: MajorCard = { doomTier: 'greater', valueParity: 'even' };
		const fool: MajorCard = { valueParity: 'even' }; // no doomTier at all

		it('matches on tier alone', () => {
			expect(cardMatchesDoomPredicate(lesser, { tier: 'lesser', operation: 'play' })).toBe(true);
			expect(cardMatchesDoomPredicate(lesser, { tier: 'greater', operation: 'play' })).toBe(false);
		});

		it('matches on parity alone', () => {
			expect(cardMatchesDoomPredicate(greater, { parity: 'even', operation: 'discard' })).toBe(true);
			expect(cardMatchesDoomPredicate(greater, { parity: 'odd', operation: 'discard' })).toBe(false);
		});

		it('requires every constrained field to match (tier AND parity)', () => {
			expect(cardMatchesDoomPredicate(lesser, { tier: 'lesser', parity: 'odd', operation: 'reveal' })).toBe(true);
			expect(cardMatchesDoomPredicate(lesser, { tier: 'lesser', parity: 'even', operation: 'reveal' })).toBe(false);
		});

		it('an unconstrained predicate field matches anything', () => {
			expect(cardMatchesDoomPredicate(lesser, { operation: 'play' })).toBe(true);
			expect(cardMatchesDoomPredicate(greater, { operation: 'play' })).toBe(true);
		});

		it('a card with no doomTier (the Fool) never satisfies a tier-constrained predicate', () => {
			expect(cardMatchesDoomPredicate(fool, { tier: 'lesser', operation: 'play' })).toBe(false);
			expect(cardMatchesDoomPredicate(fool, { tier: 'greater', operation: 'play' })).toBe(false);
			// ...but still matches a predicate that doesn't constrain tier.
			expect(cardMatchesDoomPredicate(fool, { parity: 'even', operation: 'play' })).toBe(true);
		});
	});

	describe('majorCardFrom — reads pre-classified catalog metadata, never recalculates the boundary', () => {
		const catalog = makeRichSessionCatalogFixture();

		it('classifies a lesser-doom major (number <= 14, per content — never a literal 14 here)', () => {
			expect(majorCardFrom(catalog, 'magician')).toEqual({ doomTier: 'lesser', valueParity: 'odd' });
		});

		it('classifies a greater-doom major (number >= 15, per content — never a literal 15 here)', () => {
			expect(majorCardFrom(catalog, 'devil')).toEqual({ doomTier: 'greater', valueParity: 'odd' });
		});

		it('returns undefined for a minor/player-deck card', () => {
			expect(majorCardFrom(catalog, 'cups-v')).toBeUndefined();
		});

		it('classifies the Fool with doomTier undefined (it IS a major card, just borrowed into the player deck — not a special case)', () => {
			expect(majorCardFrom(catalog, 'fool')).toEqual({ doomTier: undefined, valueParity: 'even' });
			// ...which already fails any tier-constrained predicate, with no
			// Fool-specific branch anywhere in `cardMatchesDoomPredicate`.
			expect(cardMatchesDoomPredicate(majorCardFrom(catalog, 'fool')!, { tier: 'lesser', operation: 'play' })).toBe(false);
		});

		it('returns undefined for an id absent from the catalog entirely', () => {
			expect(majorCardFrom(catalog, 'not-a-real-card')).toBeUndefined();
		});
	});
});
