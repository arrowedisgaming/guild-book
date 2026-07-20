/**
 * The GM hand-size formula and round dealing (Ch7 step 1, "Draw Challenge
 * cards" / rule `challenge-gm-hand-size`). Pure — no UI/DB/network imports
 * (see `tests/unit/session/import-boundaries.test.ts`).
 */

import { FIXED_ZONE_IDS } from '../../zones';
import { reduceSession } from '../../reducer';
import type { SessionEngineStateV1, SessionEvent } from '$lib/types/session';
import type { ChallengeStateV1, GmHandFormulaParams } from './types';
import {
	challengeHandZoneId,
	initialBudgets,
	readChallengeState,
	reject,
	writeChallengeState,
	type ChallengeReduceContext,
	type SessionReduceResult
} from './reducer';
import { assertSessionInvariants } from '../../invariants';

/**
 * "Elite" / "Dungeon Lord" — the two `denizens.json`'s `threats` catalog ids
 * (`minion`, `brute`, `strategist`, `elite`, `dungeon-lord`) the formula
 * cares about. Referenced as stable content ids, the same way
 * `card-commands.ts` references the Fool's `FOOL_CARD_ID` — not a rule
 * value, just the identifier the rule's presence-flags key off of.
 */
const ELITE_THREAT_ID = 'elite';
const DUNGEON_LORD_THREAT_ID = 'dungeon-lord';

/**
 * "Physically larger than a human" (`challenge-gm-hand-size`) has no shipped
 * content lookup table backing it (unlike `threat`, which `denizens.json`'s
 * `threats` catalog enumerates) — Appendix C leaves it to GM narrative
 * judgment. This is the engine-level sentinel a GM's `size` entry must equal
 * to count; anything else (including the unmarked default, e.g. `'human'`)
 * does not. Not a rule constant — a recognized identifier, same spirit as
 * `ELITE_THREAT_ID` above.
 */
const LARGER_THAN_HUMAN_SIZE_ID = 'larger-than-human';

/**
 * The GM Challenge hand-size formula (rule `challenge-gm-hand-size`),
 * per Increment 3 Task 2's binding override O1 — the plan's original
 * signature/body were both wrong (see the brief). Every number comes from
 * `params` (hydrated from content by `buildChallengeConfig`); this function
 * only does the counting/thresholding the rule text describes:
 *
 * ```
 * base
 * + (distinct enemy types) * perEnemyType
 * + (enemies.length >  adventurerCount)     ? enemiesOutnumberAdventurers : 0
 * + (enemies.length >= 2 * adventurerCount) ? enemiesDoubleAdventurers    : 0
 * + (enemies larger than human, count) * perLargerThanHumanEnemy
 * + (any elite present)        ? eliteEnemyPresent  : 0   (once, not per-enemy)
 * + (any dungeon lord present) ? dungeonLordPresent : 0   (once, not per-enemy)
 * ```
 *
 * Rulebook worked examples (both required, O1): 12 imps vs 4 adventurers → 6
 * (3 base + 1 one type + 1 outnumber + 1 double); 7 imps vs 4 adventurers → 5
 * (3 base + 1 one type + 1 outnumber; 7 < 8 so NOT double — pins `>=`, rules
 * out `>`).
 */
export function calculateGmHandSize(
	params: GmHandFormulaParams,
	input: { enemies: ChallengeStateV1['enemyFacts']; adventurerCount: number }
): number {
	const { enemies, adventurerCount } = input;
	const enemyTypeCount = new Set(enemies.flatMap((enemy) => enemy.typeIds)).size;
	const largerThanHumanCount = enemies.filter((enemy) => enemy.size === LARGER_THAN_HUMAN_SIZE_ID).length;
	const anyElite = enemies.some((enemy) => enemy.threat === ELITE_THREAT_ID);
	const anyDungeonLord = enemies.some((enemy) => enemy.threat === DUNGEON_LORD_THREAT_ID);

	return Math.max(
		0,
		params.base +
			enemyTypeCount * params.perEnemyType +
			(enemies.length > adventurerCount ? params.enemiesOutnumberAdventurers : 0) +
			(enemies.length >= 2 * adventurerCount ? params.enemiesDoubleAdventurers : 0) +
			largerThanHumanCount * params.perLargerThanHumanEnemy +
			(anyElite ? params.eliteEnemyPresent : 0) +
			(anyDungeonLord ? params.dungeonLordPresent : 0)
	);
}

/**
 * Deals this round's hands: `config.playerBaseHandSize` cards from the
 * player deck to every active participant's hand zone (one `deal` command,
 * many destinations), and `calculateGmHandSize(...)`-many major cards to the
 * GM hand — recalculated fresh from the *current* `enemyFacts`/participant
 * count every time this runs, per O1/step2 ("Check to see which are
 * applicable at the start of each round"). Both target counts are dealt as
 * flat totals into hands emptied by the previous round's cleanup (Ch7:
 * "players always draw four Challenge cards" / "the GM will draw 5 cards at
 * the beginning of the next round" — both stated as flat per-round totals,
 * not top-ups), so `countPerDestination` on the resulting public
 * `cards-dealt` event already IS the calculated target, satisfying "preserve
 * the calculated target in public state for audit without revealing the GM
 * hand" with no extra state field. GM-only (dealing is a GM-only structural
 * command).
 */
export function dealRound(state: SessionEngineStateV1, context: ChallengeReduceContext): SessionReduceResult {
	if (context.actor.kind !== 'gm') {
		return reject('not-authorized', 'only the GM may deal a Challenge round');
	}
	const challenge = readChallengeState(state);
	if (!challenge) return reject('illegal-command', 'no active Challenge round');
	if (challenge.stage !== 'deal') {
		return reject('illegal-command', `cannot deal during stage ${challenge.stage}`);
	}

	const gmHandTarget = calculateGmHandSize(context.config.gmHandFormula, {
		enemies: challenge.enemyFacts,
		adventurerCount: challenge.participantTenureIds.length
	});
	const playerHandTarget = context.config.playerBaseHandSize;

	const playerDealResult = reduceSession(
		state,
		{
			type: 'deal',
			deck: 'player',
			destinationZoneIds: challenge.participantTenureIds.map(challengeHandZoneId),
			countPerDestination: playerHandTarget
		},
		context
	);
	if (!playerDealResult.ok) return playerDealResult;

	const gmDealResult = reduceSession(
		playerDealResult.state,
		{ type: 'deal', deck: 'major', destinationZoneIds: [FIXED_ZONE_IDS.gmHand], countPerDestination: gmHandTarget },
		context
	);
	if (!gmDealResult.ok) return gmDealResult;

	const nextChallenge: ChallengeStateV1 = {
		...challenge,
		stage: 'initiative-placement',
		budgets: initialBudgets(challenge.participantTenureIds)
	};
	const nextState = writeChallengeState(gmDealResult.state, nextChallenge);
	assertSessionInvariants(nextState, context.runtime.catalog);

	const event: SessionEvent = {
		kind: 'challenge-hand-sizes-calculated',
		publicPayload: { round: challenge.round, playerHandSize: playerHandTarget, gmHandSize: gmHandTarget }
	};
	return { ok: true, state: nextState, events: [...playerDealResult.events, ...gmDealResult.events, event] };
}
