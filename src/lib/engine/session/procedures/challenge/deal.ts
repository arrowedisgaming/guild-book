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
 *
 * Exported (review round) so `GmChallengeControls.svelte`'s enemy-fact form
 * can render the ONE mechanically meaningful size distinction as a checkbox
 * ("larger than a human" / not) rather than a free-text field a GM could
 * mistype into silently scoring nothing — the component imports this
 * constant rather than re-typing the string itself (O2: no game rules in
 * components).
 */
export const LARGER_THAN_HUMAN_SIZE_ID = 'larger-than-human';
/** The unmarked default `size` value — anything not
 * `LARGER_THAN_HUMAN_SIZE_ID` scores identically to this, so it is the
 * canonical "not larger than human" value a UI should send. */
export const DEFAULT_ENEMY_SIZE_ID = 'human';

/**
 * The GM Challenge hand-size formula (rule `challenge-gm-hand-size`),
 * per Increment 3 Task 2's binding override O1 — the plan's original
 * signature/body were both wrong (see the brief). Every number comes from
 * `params` (hydrated from content by `buildChallengeConfig`); this function
 * only does the counting/thresholding the rule text describes.
 *
 * `enemies` entries are groups, not individual creatures (`types.ts`'s
 * `ChallengeEnemyFact` doc comment) — this formula therefore reads
 * *headcount* as the sum of every entry's `count`, not `enemies.length`
 * (a coordinator-identified defect: `enemies.length` and `placeGmInitiative`
 * both reading an entry as "one enemy" made the rulebook's own worked
 * example — twelve imps as one group needing only one Initiative card —
 * impossible to represent correctly at both consumers simultaneously):
 *
 * ```
 * base
 * + (distinct enemy types) * perEnemyType
 * + (totalCount >  adventurerCount)     ? enemiesOutnumberAdventurers : 0
 * + (totalCount >= 2 * adventurerCount) ? enemiesDoubleAdventurers    : 0
 * + (headcount of enemies larger than human) * perLargerThanHumanEnemy
 * + (any elite present)        ? eliteEnemyPresent  : 0   (once, not per-head)
 * + (any dungeon lord present) ? dungeonLordPresent : 0   (once, not per-head)
 * ```
 *
 * where `totalCount = sum(enemies.map(e => e.count))`. Distinct-type
 * counting and the elite/dungeon-lord presence flags are NOT headcount-
 * weighted — a type is counted once regardless of how many individuals share
 * it, and presence is presence, not a per-head bonus — only the
 * outnumber/double thresholds and `perLargerThanHumanEnemy` scale with
 * `count`.
 *
 * Rulebook worked examples (both required, O1), now expressed as the single
 * group entries the book actually describes: `[{typeIds:['imp'], count:12}]`
 * vs 4 adventurers → 6 (3 base + 1 one type + 1 outnumber + 1 double);
 * `[{typeIds:['imp'], count:7}]` vs 4 adventurers → 5 (3 base + 1 one type +
 * 1 outnumber; 7 < 8 so NOT double — pins `>=`, rules out `>`). Both now also
 * require exactly ONE `placeGmInitiative` call (`initiative.ts`) — one
 * group, one card — proving the two consumers agree.
 */
export function calculateGmHandSize(
	params: GmHandFormulaParams,
	input: { enemies: ChallengeStateV1['enemyFacts']; adventurerCount: number }
): number {
	const { enemies, adventurerCount } = input;
	const totalCount = enemies.reduce((sum, enemy) => sum + enemy.count, 0);
	const enemyTypeCount = new Set(enemies.flatMap((enemy) => enemy.typeIds)).size;
	const largerThanHumanCount = enemies
		.filter((enemy) => enemy.size === LARGER_THAN_HUMAN_SIZE_ID)
		.reduce((sum, enemy) => sum + enemy.count, 0);
	const anyElite = enemies.some((enemy) => enemy.threat === ELITE_THREAT_ID);
	const anyDungeonLord = enemies.some((enemy) => enemy.threat === DUNGEON_LORD_THREAT_ID);

	return Math.max(
		0,
		params.base +
			enemyTypeCount * params.perEnemyType +
			(totalCount > adventurerCount ? params.enemiesOutnumberAdventurers : 0) +
			(totalCount >= 2 * adventurerCount ? params.enemiesDoubleAdventurers : 0) +
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
 * applicable at the start of each round").
 *
 * Both target counts are dealt as FLAT totals, not top-ups, into hands
 * emptied by the previous round's cleanup — confirmed against two rule
 * entries (not just inferred from wording, per the controller's concern-1
 * follow-up):
 *
 *   `challenge-draw-cards`: "At the beginning of each round, each player
 *   draws four Challenge cards from the minor arcana deck."
 *
 *   `challenge-end-the-round`: "Any remaining Challenge cards in your hand
 *   are discarded. The players and the GM draw more Challenge cards and
 *   begin a new round."
 *
 * The second entry is `cleanupRound`'s (`reducer.ts`) authority for
 * discarding hand contents at the round boundary — do not "fix" that back
 * toward a top-up model; it was checked, not guessed. (The same rule's
 * "Facedown actions are left facedown" is why `cleanupRound` never sweeps a
 * facedown/prepared zone by kind — see that function's doc comment.)
 *
 * Because dealing is flat, `countPerDestination` on the resulting public
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
