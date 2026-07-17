import { describe, it, expect } from 'vitest';
import {
	buildMinorDeck,
	buildPlayerDeck,
	buildMajorDeck,
	buildFool,
	shuffleDeck,
	draw,
	drawWithReshuffle
} from '$lib/engine/tarot-deck';
import { resolveTestOfFate, classifyOutcome } from '$lib/engine/tarot-resolution';
import { makeRng } from '$lib/engine/rng';
import { getContentPack } from '$lib/server/content/loader';

const config = getContentPack().tarot;

describe('tarot deck', () => {
	it('builds 56 unique minor-arcana cards', () => {
		const minor = buildMinorDeck(config);
		expect(minor).toHaveLength(56);
		expect(new Set(minor.map((c) => c.id)).size).toBe(56);
	});

	it('player deck is the 56 minor cards plus the Fool (57 unique)', () => {
		const deck = buildPlayerDeck(config);
		expect(deck).toHaveLength(57);
		expect(new Set(deck.map((c) => c.id)).size).toBe(57);
		expect(deck.some((c) => c.id === 'fool')).toBe(true);
	});

	it("GM deck is the 21 major arcana, Fool excluded", () => {
		const major = buildMajorDeck(config);
		expect(major).toHaveLength(21);
		expect(major.some((c) => c.id === 'fool')).toBe(false);
	});

	it('shuffles deterministically and preserves the card set', () => {
		const deck = buildPlayerDeck(config);
		const a = shuffleDeck(deck, 'seed-1');
		const b = shuffleDeck(deck, 'seed-1');
		const c = shuffleDeck(deck, 'seed-2');
		expect(a.map((x) => x.id)).toEqual(b.map((x) => x.id)); // reproducible
		expect(a.map((x) => x.id)).not.toEqual(c.map((x) => x.id)); // seed matters
		expect(new Set(a.map((x) => x.id))).toEqual(new Set(deck.map((x) => x.id))); // no loss
	});

	it('draws n cards off the top and returns the remainder', () => {
		const deck = buildPlayerDeck(config);
		const { drawn, rest } = draw(deck, 3);
		expect(drawn).toHaveLength(3);
		expect(rest).toHaveLength(54);
		expect(drawn).toEqual(deck.slice(0, 3));
	});

	it('auto-reshuffles the discard when the draw pile is empty', () => {
		const rng = makeRng('reshuffle');
		const discard = buildPlayerDeck(config); // 57 cards to fall back on
		const res = drawWithReshuffle([], discard, 2, rng);
		expect(res.reshuffled).toBe(true);
		expect(res.drawn).toHaveLength(2);
		expect(res.drawPile).toHaveLength(55); // 57 reshuffled - 2 drawn
		expect(res.discard).toHaveLength(0);
	});

	it('stops when both piles are exhausted (no infinite loop)', () => {
		const rng = makeRng('empty');
		const res = drawWithReshuffle([], [], 5, rng);
		expect(res.drawn).toHaveLength(0);
		expect(res.reshuffled).toBe(false);
	});
});

describe('test of fate', () => {
	it('Knight of Wands (12) + Pentacles 2 = 14 → success', () => {
		const r = resolveTestOfFate(config, {
			attribute: 2,
			initialCard: { id: 'wands-knight', value: 12, suit: 'wands', origin: 'test-draw' },
			pushCard: null,
			testedSuit: 'pentacles',
			favor: false,
			disfavor: false,
			resolveSpentForFavor: false
		});
		expect(r.total).toBe(14);
		expect(r.outcome).toBe('success');
	});

	it('tested suit on the initial draw + 14 → great success', () => {
		const r = resolveTestOfFate(config, {
			attribute: 4,
			initialCard: { id: 'swords-x', value: 10, suit: 'swords', origin: 'test-draw' },
			pushCard: null,
			testedSuit: 'swords',
			favor: false,
			disfavor: false,
			resolveSpentForFavor: false
		});
		expect(r.total).toBe(14);
		expect(r.outcome).toBe('great-success');
	});

	it('total ≤ 13 with no push → failure', () => {
		const r = resolveTestOfFate(config, {
			attribute: 1,
			initialCard: { id: 'cups-ii', value: 2, suit: 'cups', origin: 'test-draw' },
			pushCard: null,
			testedSuit: 'wands',
			favor: false,
			disfavor: false,
			resolveSpentForFavor: false
		});
		expect(r.outcome).toBe('failure');
	});

	it('pushed fate and still ≤ 13 → great failure', () => {
		const r = classifyOutcome({
			total: 11,
			successThreshold: 14,
			greatSuccessOnMatchingSuit: true,
			initialDrawMatchedTestedSuit: false,
			pushedFate: true
		});
		expect(r).toBe('great-failure');
	});

	it('initial tested-suit draw but pushed to reach 14+ → ordinary success (Arrowed ruling)', () => {
		const r = classifyOutcome({
			total: 15,
			successThreshold: 14,
			greatSuccessOnMatchingSuit: true,
			initialDrawMatchedTestedSuit: true,
			pushedFate: true
		});
		expect(r).toBe('success');
	});
});

describe('derived major metadata', () => {
	it('builds 78 globally unique stable card ids', () => {
		const cards = [...buildPlayerDeck(config), ...buildMajorDeck(config)];
		expect(cards).toHaveLength(78);
		expect(new Set(cards.map((card) => card.id)).size).toBe(78);
	});

	it('derives doom tier and parity for GM majors', () => {
		const cards = buildMajorDeck(config);
		expect(cards.find((card) => card.number === 14)).toMatchObject({
			doomTier: 'lesser',
			valueParity: 'even'
		});
		expect(cards.find((card) => card.number === 15)).toMatchObject({
			doomTier: 'greater',
			valueParity: 'odd'
		});
	});

	it('reads the doom boundary from content rather than hardcoding it', () => {
		const shifted = {
			...config,
			doomTiers: {
				lesser: { ...config.doomTiers.lesser, to: 10 },
				greater: { ...config.doomTiers.greater, from: 11 }
			}
		};
		const cards = buildMajorDeck(shifted);
		expect(cards.find((c) => c.number === 11)?.doomTier).toBe('greater');
		expect(cards.find((c) => c.number === 14)?.doomTier).toBe('greater');
	});

	it('models the Fool by id with value zero and no doom tier', () => {
		expect(buildFool(config)).toMatchObject({ id: 'fool', number: 0, value: 0 });
		expect(buildFool(config)?.doomTier).toBeUndefined();
	});
});
