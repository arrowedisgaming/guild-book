/**
 * Deck-exhaustion drawing and boundary reshuffles for the shared tarot table.
 * Pure — no UI/DB/network imports (see
 * `tests/unit/session/import-boundaries.test.ts`).
 */

import type { CardId } from '$lib/types/session';
import { shuffle, type Rng } from '../rng';

export interface DrawWithReshuffleResult {
	drawn: CardId[];
	drawPile: CardId[];
	discardPile: CardId[];
	/** True when the discard pile had to be shuffled back into the draw pile
	 * to satisfy the request (spec §8.4 deck-exhaustion reshuffling). */
	reshuffled: boolean;
}

export interface DrawInsufficientResult {
	insufficient: true;
	/** Total cards available across draw + discard — always `< count`. */
	available: number;
}

/**
 * Draws `count` cards off the top of `drawPile`. If the pile alone is
 * insufficient, shuffles `discardPile` into it with `rng` and continues
 * (spec §8.4: "the engine automatically shuffles only the eligible discard
 * pile and continues"). Cards already in hands, initiative, face-down play,
 * inspiration, pending selections, or any other in-play zone are excluded by
 * construction — they were never in `drawPile`/`discardPile` to begin with.
 * Returns `{ insufficient: true, available }` when draw + discard together
 * cannot satisfy `count`; never mutates its inputs.
 */
export function drawWithReshuffle(
	drawPile: readonly CardId[],
	discardPile: readonly CardId[],
	count: number,
	rng: Rng
): DrawWithReshuffleResult | DrawInsufficientResult {
	if (drawPile.length >= count) {
		return {
			drawn: drawPile.slice(0, count),
			drawPile: drawPile.slice(count),
			discardPile: discardPile.slice(),
			reshuffled: false
		};
	}

	const available = drawPile.length + discardPile.length;
	if (available < count) {
		return { insufficient: true, available };
	}

	const reshuffledPile = shuffle([...drawPile, ...discardPile], rng);
	return {
		drawn: reshuffledPile.slice(0, count),
		drawPile: reshuffledPile.slice(count),
		discardPile: [],
		reshuffled: true
	};
}

/**
 * Combines `drawPile` and `discardPile` into one freshly shuffled draw pile,
 * emptying the discard. Used for the Fool's scheduled boundary reshuffle
 * (spec §8.4) — held/in-play cards are untouched because they were never in
 * either pile.
 */
export function reshuffleDeck(
	drawPile: readonly CardId[],
	discardPile: readonly CardId[],
	rng: Rng
): { drawPile: CardId[]; discardPile: CardId[] } {
	return { drawPile: shuffle([...drawPile, ...discardPile], rng), discardPile: [] };
}
