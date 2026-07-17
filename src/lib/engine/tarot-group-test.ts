/**
 * Group tests (His Majesty the Worm, Ch. 1 "Group tests").
 *
 * Two adventurers test fate — the most and least qualified — and the GM totals
 * their hits. Both halves are pure and content-driven: the hit values are the
 * book's, and the outcome bands come from `resolution.groupOutcomes`.
 */

import type { TarotConfig, GroupOutcomeBand } from '$lib/types/content-pack';
import type { OutcomeId } from './tarot-resolution';

export interface GroupTestCandidate {
	id: string;
	/** The tested attribute's value for this adventurer. */
	attribute: number;
	/** Position in the guild's roster — the stable tie-break. */
	rosterOrder: number;
}

export interface GroupTestSelection {
	mostQualified: GroupTestCandidate;
	leastQualified: GroupTestCandidate;
	/** Everyone sharing the highest attribute; length > 1 means a tie. */
	tiedForMost: GroupTestCandidate[];
	tiedForLeast: GroupTestCandidate[];
	/**
	 * True when either end is tied. Ch1: "If there are apparent ties, talk it out
	 * to determine who should make the tests." The book makes that a table
	 * decision, so this proposes a stable default and flags that the table may
	 * override it — it does not invent a rule the game does not have.
	 */
	requiresTableDecision: boolean;
}

/**
 * Propose who tests. Ties resolve to roster order for determinism, but are
 * reported so the UI can ask the table.
 */
export function selectGroupTestActors(candidates: GroupTestCandidate[]): GroupTestSelection {
	if (new Set(candidates.map((candidate) => candidate.id)).size < 2) {
		throw new Error('a group test needs at least two distinct adventurers');
	}
	const byRoster = [...candidates].sort((a, b) => a.rosterOrder - b.rosterOrder);
	const highest = Math.max(...byRoster.map((c) => c.attribute));
	const lowest = Math.min(...byRoster.map((c) => c.attribute));

	const tiedForMost = byRoster.filter((c) => c.attribute === highest);
	const tiedForLeast = byRoster.filter((c) => c.attribute === lowest);

	const mostQualified = tiedForMost[0];
	const leastQualified =
		tiedForLeast.find((candidate) => candidate.id !== mostQualified.id) ??
		byRoster.find((candidate) => candidate.id !== mostQualified.id)!;

	return {
		mostQualified,
		leastQualified,
		tiedForMost,
		tiedForLeast,
		requiresTableDecision: tiedForMost.length > 1 || tiedForLeast.length > 1
	};
}

/** Ch1: success gives 1 hit, great success 2, failure 0, great failure -1. */
const GROUP_HITS: Record<OutcomeId, number> = {
	'great-success': 2,
	success: 1,
	failure: 0,
	'great-failure': -1
};

export interface GroupTestResult {
	hits: number;
	outcome: GroupOutcomeBand;
}

/**
 * Total the hits and classify. The band table is content, not code — which is
 * why `config` is a parameter rather than an import.
 */
export function resolveGroupTest(config: TarotConfig, outcomes: OutcomeId[]): GroupTestResult {
	if (outcomes.length !== 2) {
		throw new Error(`a group test requires exactly two outcomes; received ${outcomes.length}`);
	}
	const hits = outcomes.reduce((sum, outcome) => sum + GROUP_HITS[outcome], 0);
	const band = config.resolution.groupOutcomes.find((o) => hits >= o.from && hits <= o.to);
	if (!band) {
		throw new Error(`no group outcome band covers ${hits} hits`);
	}
	return { hits, outcome: band };
}
