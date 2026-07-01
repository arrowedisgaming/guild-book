/**
 * Tarot draw protocol — JSON-serializable shapes for a draw and its result.
 * Kept plain (no class instances, no functions) so a DrawResult can later be
 * persisted per-guild in the `guild_draws` table exactly as-is.
 */

import type { SuitId, RankId } from '$lib/types/common';
import type { TarotCard } from '$lib/engine/tarot-deck';
import type { OutcomeId } from '$lib/engine/tarot-resolution';

export interface DrawnCard {
	id: string;
	kind: 'minor' | 'major';
	label: string;
	value: number;
	suit?: SuitId;
	rank?: RankId;
}

export interface TestSummary {
	testedSuit: SuitId;
	attribute: number;
	total: number;
	pushed: boolean;
	outcome: OutcomeId;
	outcomeLabel: string;
}

export interface DrawResult {
	id: string;
	at: string;
	cards: DrawnCard[];
	reshuffled: boolean;
	reason?: string;
	/** Present when the draw was a resolved test of fate. */
	test?: TestSummary;
}

/** Flatten an engine TarotCard into the serializable DrawnCard shape. */
export function toDrawnCard(card: TarotCard): DrawnCard {
	if (card.kind === 'minor') {
		return {
			id: card.id,
			kind: 'minor',
			label: card.label,
			value: card.value,
			suit: card.suit,
			rank: card.rank
		};
	}
	return { id: card.id, kind: 'major', label: card.name, value: card.value };
}
