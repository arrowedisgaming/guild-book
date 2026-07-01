/**
 * Builds and manipulates the His Majesty the Worm tarot decks from a content
 * pack's TarotConfig. Two decks: the player deck (56 minor arcana + the Fool)
 * and the GM deck (major arcana I–XXI). Pure — no UI/DB, no Math.random.
 */

import type { TarotConfig } from '$lib/types/content-pack';
import type { SuitId, RankId } from '$lib/types/common';
import { SUIT_LABELS } from '$lib/types/common';
import { makeRng, shuffle, type Rng } from './rng';

export interface MinorCard {
	kind: 'minor';
	id: string;
	suit: SuitId;
	rank: RankId;
	/** Value added on a test of fate. */
	value: number;
	label: string;
}

export interface MajorCard {
	kind: 'major';
	id: string;
	number: number;
	name: string;
	/** The Fool is 0; majors otherwise carry their number. */
	value: number;
}

export type TarotCard = MinorCard | MajorCard;

const FOOL_ID = 'fool';

/** All 56 minor-arcana cards (4 suits × 14 ranks). */
export function buildMinorDeck(config: TarotConfig): MinorCard[] {
	const cards: MinorCard[] = [];
	for (const suit of config.suits) {
		for (const rank of config.ranks) {
			cards.push({
				kind: 'minor',
				id: `${suit}-${rank.id}`,
				suit,
				rank: rank.id,
				value: rank.numeric,
				label: `${rank.label} of ${SUIT_LABELS[suit]}`
			});
		}
	}
	return cards;
}

/** The Fool, borrowed from the major arcana into the player deck. */
export function buildFool(config: TarotConfig): MajorCard | null {
	const fool = config.majorArcana.find((c) => c.id === FOOL_ID);
	if (!fool) return null;
	return { kind: 'major', id: fool.id, number: fool.number, name: fool.name, value: fool.number };
}

/**
 * The deck players draw from during tests of fate: all minor arcana plus the
 * Fool (57 cards).
 */
export function buildPlayerDeck(config: TarotConfig): TarotCard[] {
	const minor = buildMinorDeck(config);
	const fool = buildFool(config);
	return fool ? [...minor, fool] : minor;
}

/** The GM's deck: major arcana excluding the Fool (I–XXI). */
export function buildMajorDeck(config: TarotConfig): MajorCard[] {
	return config.majorArcana
		.filter((c) => c.id !== FOOL_ID)
		.map((c) => ({ kind: 'major' as const, id: c.id, number: c.number, name: c.name, value: c.number }));
}

/** Shuffle a deck deterministically from a seed (or an existing Rng). */
export function shuffleDeck<T extends TarotCard>(cards: readonly T[], seedOrRng: string | number | Rng): T[] {
	const rng = typeof seedOrRng === 'function' ? seedOrRng : makeRng(seedOrRng);
	return shuffle(cards, rng);
}

/** Draw `count` cards off the top of a pile, returning them and the remainder. */
export function draw<T extends TarotCard>(pile: readonly T[], count = 1): { drawn: T[]; rest: T[] } {
	const n = Math.max(0, Math.min(count, pile.length));
	return { drawn: pile.slice(0, n), rest: pile.slice(n) };
}

export function isMinor(card: TarotCard): card is MinorCard {
	return card.kind === 'minor';
}
