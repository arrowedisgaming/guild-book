/**
 * Test-of-fate resolution — the core mechanic. A player draws minor-arcana
 * card(s) and adds the relevant attribute; the total determines the outcome.
 * Data-driven from the content pack's TarotConfig so the real thresholds are
 * content, not code. Pure.
 *
 * The four outcomes (His Majesty the Worm, Ch. 1):
 *   • Success       — total ≥ 14.
 *   • Failure       — total ≤ 13.
 *   • Great success — total ≥ 14 AND the tested suit was drawn on the INITIAL
 *                     draw (not from pushing fate).
 *   • Great failure — the player pushed fate and the total is STILL ≤ 13.
 */

import type { TarotConfig } from '$lib/types/content-pack';
import type { SuitId } from '$lib/types/common';

export type OutcomeId = 'great-success' | 'success' | 'failure' | 'great-failure';

export interface DrawnValue {
	value: number;
	suit?: SuitId;
}

export interface TestContext {
	/** The tested attribute's value (1–4). */
	attribute: number;
	/** Cards drawn, initial first. Pushing fate appends more. */
	cards: DrawnValue[];
	/** The suit being tested. */
	testedSuit: SuitId;
	/** Whether the player pushed fate (drew beyond the initial card). */
	pushedFate: boolean;
}

export interface TestResult {
	total: number;
	outcome: OutcomeId;
	outcomeLabel: string;
	initialDrawMatchedTestedSuit: boolean;
}

/**
 * Classify a test-of-fate outcome from its computed facts.
 *
 * Ruling (Arrowed): great success requires clearing the threshold on the
 * INITIAL tested-suit draw *without pushing fate*. If you had to push to reach
 * 14+ — even off an initial tested-suit card — it is an ordinary success.
 */
export function classifyOutcome(params: {
	total: number;
	successThreshold: number;
	greatSuccessOnMatchingSuit: boolean;
	initialDrawMatchedTestedSuit: boolean;
	pushedFate: boolean;
}): OutcomeId {
	const success = params.total >= params.successThreshold;
	if (success) {
		if (
			params.greatSuccessOnMatchingSuit &&
			params.initialDrawMatchedTestedSuit &&
			!params.pushedFate
		) {
			return 'great-success';
		}
		return 'success';
	}
	// Failure. Pushing fate and still failing is a great failure.
	return params.pushedFate ? 'great-failure' : 'failure';
}

/** Run a full test of fate: sum the cards + attribute and classify. */
export function testOfFate(config: TarotConfig, ctx: TestContext): TestResult {
	const cardTotal = ctx.cards.reduce((sum, c) => sum + c.value, 0);
	const total = ctx.attribute + cardTotal;
	const initialDrawMatchedTestedSuit = ctx.cards[0]?.suit === ctx.testedSuit;

	const outcome = classifyOutcome({
		total,
		successThreshold: config.resolution.successThreshold,
		greatSuccessOnMatchingSuit: config.resolution.greatSuccessOnMatchingSuit,
		initialDrawMatchedTestedSuit,
		pushedFate: ctx.pushedFate
	});

	const outcomeLabel =
		config.resolution.outcomes.find((o) => o.id === outcome)?.label ?? outcome;

	return { total, outcome, outcomeLabel, initialDrawMatchedTestedSuit };
}
