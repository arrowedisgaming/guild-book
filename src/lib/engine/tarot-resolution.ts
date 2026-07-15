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

import type { TarotConfig, GroupOutcomeBand } from '$lib/types/content-pack';
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

// ---------------------------------------------------------------------------
// Card-explicit resolution (favor/disfavor, Resolve, pushing, the Fool)
// ---------------------------------------------------------------------------

const FOOL_ID = 'fool';

export interface ResolutionCard {
	id: string;
	value: number;
	suit?: SuitId;
}

/** Why a test had favor. Reported so the table log can explain the +3. */
export type FavorSource = 'circumstance' | 'resolve';

export interface TestOfFateInput {
	attribute: number;
	testedSuit: SuitId;
	initialCard: ResolutionCard;
	/** The extra card from pushing fate, or null if the player did not push. */
	pushCard: ResolutionCard | null;
	/** Circumstantial favor (aid, a relevant motif, fictional positioning). */
	favor: boolean;
	disfavor: boolean;
	/**
	 * Whether the player spent 1 Resolve before drawing. Ch1: "You may elect to
	 * spend a point of Resolve *prior* to a test of fate in order to gain favor."
	 * It is a source of favor, not a separate modifier, and never a push cost —
	 * pushing is free.
	 */
	resolveSpentForFavor: boolean;
}

export interface TestOfFateResult {
	total: number;
	/** The applied favor/disfavor adjustment: +n, -n, or 0. */
	modifier: number;
	favorSources: FavorSource[];
	outcome: OutcomeId;
	outcomeLabel: string;
	initialDrawMatchedTestedSuit: boolean;
	pushed: boolean;
	/** True only when this test failed without a push, so a free push remains. */
	canPush: boolean;
	/** Ch1: a Fool pulled while pushing is a great failure regardless of total. */
	automaticGreatFailure: boolean;
	/** Ch1: "When the Fool is drawn, remember to shuffle both … decks." */
	foolDrawn: boolean;
}

/**
 * Resolve a complete test of fate from the cards actually drawn.
 *
 * Every rule here is content-driven or cited: favor is `favorModifier` from the
 * pack (Ch1, non-cumulative, cancelled by disfavor), the threshold is
 * `successThreshold`, a push can never great-succeed, and the Fool's three
 * behaviours follow Ch1's "Pushing fate with the Fool".
 */
export function resolveTestOfFate(config: TarotConfig, input: TestOfFateInput): TestOfFateResult {
	const favorSources: FavorSource[] = [];
	if (input.favor) favorSources.push('circumstance');
	if (input.resolveSpentForFavor) favorSources.push('resolve');

	// Non-cumulative, and one cancels the other — so this is a three-way choice,
	// never a sum.
	const hasFavor = favorSources.length > 0;
	const step = config.resolution.favorModifier;
	const modifier = hasFavor === input.disfavor ? 0 : hasFavor ? step : -step;

	const pushed = input.pushCard !== null;
	const cardTotal = input.initialCard.value + (input.pushCard?.value ?? 0);
	const total = input.attribute + cardTotal + modifier;

	const initialDrawMatchedTestedSuit = input.initialCard.suit === input.testedSuit;
	const automaticGreatFailure = input.pushCard?.id === FOOL_ID;
	const foolDrawn = input.initialCard.id === FOOL_ID || input.pushCard?.id === FOOL_ID;

	const outcome: OutcomeId = automaticGreatFailure
		? 'great-failure'
		: classifyOutcome({
				total,
				successThreshold: config.resolution.successThreshold,
				greatSuccessOnMatchingSuit: config.resolution.greatSuccessOnMatchingSuit,
				initialDrawMatchedTestedSuit,
				pushedFate: pushed
			});

	return {
		total,
		modifier,
		favorSources,
		outcome,
		outcomeLabel: config.resolution.outcomes.find((o) => o.id === outcome)?.label ?? outcome,
		initialDrawMatchedTestedSuit,
		pushed,
		canPush: !pushed && outcome === 'failure',
		automaticGreatFailure,
		foolDrawn
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
 * Classify a group test. Ch1: the most- and least-qualified adventurers each
 * test; the GM totals the hits. The band table is content, not code — passing
 * `config` is what lets it be.
 */
export function resolveGroupTest(config: TarotConfig, outcomes: OutcomeId[]): GroupTestResult {
	const hits = outcomes.reduce((sum, outcome) => sum + GROUP_HITS[outcome], 0);
	const band = config.resolution.groupOutcomes.find((o) => hits >= o.from && hits <= o.to);
	if (!band) {
		throw new Error(`no group outcome band covers ${hits} hits`);
	}
	return { hits, outcome: band };
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
