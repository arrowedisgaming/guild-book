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

/** Which Doom abilities a major can activate (Ch7). The Fool has no tier. */
export type DoomTier = 'lesser' | 'greater';
export type ValueParity = 'odd' | 'even';

export interface MajorCard {
	kind: 'major';
	id: string;
	number: number;
	name: string;
	/** The Fool is 0; majors otherwise carry their number. */
	value: number;
	/**
	 * Lesser or greater Doom. Absent for the Fool, which is borrowed into the
	 * player deck and is not a Doom card.
	 */
	doomTier?: DoomTier;
	valueParity: ValueParity;
}

export type TarotCard = MinorCard | MajorCard;

const FOOL_ID = 'fool';

/**
 * Derives a major's typed metadata. The lesser/greater boundary is a game rule
 * read from `config.doomTiers`, not an engine constant — Ch7 states it, and
 * hardcoding 14 here would put a rule outside the content pack.
 */
function toMajorCard(config: TarotConfig, card: TarotConfig['majorArcana'][number]): MajorCard {
	const { lesser, greater } = config.doomTiers;
	const inBand = (band: { from: number; to: number }) =>
		card.number >= band.from && card.number <= band.to;
	return {
		kind: 'major',
		id: card.id,
		number: card.number,
		name: card.name,
		value: card.number,
		doomTier:
			card.id === FOOL_ID ? undefined : inBand(lesser) ? 'lesser' : inBand(greater) ? 'greater' : undefined,
		valueParity: card.number % 2 === 0 ? 'even' : 'odd'
	};
}

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
	return fool ? toMajorCard(config, fool) : null;
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
	return config.majorArcana.filter((c) => c.id !== FOOL_ID).map((c) => toMajorCard(config, c));
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

/**
 * Draw `count` cards, auto-reshuffling the discard pile back into the draw pile
 * when it runs dry (Arrowed ruling: reshuffle automatically). Cards already in
 * hand are the caller's concern — only the draw and discard piles move here.
 * Returns the drawn cards, the updated piles, and whether a reshuffle happened
 * (so the UI can flash a cue). Pure.
 */
export function drawWithReshuffle<T extends TarotCard>(
	drawPile: readonly T[],
	discard: readonly T[],
	count: number,
	rng: Rng
): { drawn: T[]; drawPile: T[]; discard: T[]; reshuffled: boolean } {
	let pile = drawPile.slice();
	let disc = discard.slice();
	let reshuffled = false;
	const drawn: T[] = [];

	for (let i = 0; i < count; i++) {
		if (pile.length === 0) {
			if (disc.length === 0) break; // nothing left in either pile
			pile = shuffle(disc, rng);
			disc = [];
			reshuffled = true;
		}
		drawn.push(pile[0]);
		pile = pile.slice(1);
	}

	return { drawn, drawPile: pile, discard: disc, reshuffled };
}
