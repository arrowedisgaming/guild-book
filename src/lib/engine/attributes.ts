/**
 * Attribute assignment. HMTW gives every adventurer the fixed spread {4,3,2,1};
 * the 4 is locked to the suit of the chosen Path, and the player distributes the
 * remaining values across the other three suits. Pure.
 */

import type { SuitId } from '$lib/types/common';
import { SUIT_IDS } from '$lib/types/common';
import type { AttributeState, AllocationSource } from '$lib/types/character';

export interface SpreadAssignment {
	pathSuit: SuitId;
	/** The full spread, highest first (e.g. [4, 3, 2, 1]). */
	spread: number[];
	/**
	 * The three non-path suits in the order they should receive the remaining
	 * (non-highest) spread values, descending. Length must be 3.
	 */
	otherSuits: SuitId[];
}

/**
 * Produce a suit→value map from a spread assignment. The highest spread value
 * goes to `pathSuit`; the rest are handed to `otherSuits` in order.
 */
export function assignAttributeSpread(input: SpreadAssignment): Record<SuitId, number> {
	const sorted = [...input.spread].sort((a, b) => b - a);
	const [highest, ...rest] = sorted;

	const values = Object.fromEntries(SUIT_IDS.map((s) => [s, 0])) as Record<SuitId, number>;
	values[input.pathSuit] = highest;
	input.otherSuits.forEach((suit, i) => {
		values[suit] = rest[i] ?? 0;
	});
	return values;
}

/** Wrap a suit→value map in AttributeState, recording provenance for each. */
export function buildAttributeStates(
	values: Record<SuitId, number>,
	params: { pathSuit: SuitId; pathLabel: string; at: string }
): Record<SuitId, AttributeState> {
	const states = {} as Record<SuitId, AttributeState>;
	for (const suit of SUIT_IDS) {
		const isPathSuit = suit === params.pathSuit;
		const source: AllocationSource = {
			source: isPathSuit ? 'path' : 'personal',
			sourceLabel: isPathSuit ? params.pathLabel : 'Assigned spread',
			at: params.at
		};
		states[suit] = { value: values[suit] ?? 0, sources: [source] };
	}
	return states;
}

/** True when `values` is a permutation of `spread`. */
export function isValidSpread(values: Record<SuitId, number>, spread: number[]): boolean {
	const expected = [...spread].sort((a, b) => a - b);
	const actual = SUIT_IDS.map((s) => values[s] ?? 0).sort((a, b) => a - b);
	return expected.length === actual.length && expected.every((v, i) => v === actual[i]);
}

/** The suit holding the highest value (ties resolve in SUIT_IDS order). */
export function highestSuit(values: Record<SuitId, number>): SuitId {
	return SUIT_IDS.reduce((best, s) => ((values[s] ?? 0) > (values[best] ?? 0) ? s : best), SUIT_IDS[0]);
}
