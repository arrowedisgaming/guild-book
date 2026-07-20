/**
 * Setup and round-boundary orchestration for the Challenge procedure (Ch7,
 * "The Flow of the Challenge Phase"). Composes the shared session engine's
 * public `reduceSession` API — every card movement here is an ordinary
 * `SessionCommand` run through the same authorization/invariant pipeline
 * every other procedure uses — plus a Challenge-only state slice
 * (`ChallengeStateV1`) stored in `SessionEngineStateV1.procedure.gmPrivate`,
 * exactly as `types.ts` documents. This module never reaches into
 * `card-commands.ts` directly and the shared `reducer.ts`/`card-commands.ts`
 * needed no changes to support it (see the Increment 3 Task 2 report for
 * why). Pure — no UI/DB/network imports (see
 * `tests/unit/session/import-boundaries.test.ts`).
 *
 * Dealing (`dealRound`/`calculateGmHandSize`) lives in `deal.ts`; Initiative
 * placement/reveal lives in `initiative.ts`. Both import the zone-id
 * conventions and `ChallengeStateV1` read/write helpers defined here.
 */

import type {
	CardId,
	SessionEngineStateV1,
	SessionEvent,
	SessionRejection
} from '$lib/types/session';
import { assertSessionInvariants } from '../../invariants';
import { findZoneDescriptor } from '../../state';
import { FIXED_ZONE_IDS } from '../../zones';
import { reduceSession, type ReduceContext } from '../../reducer';
import type { ReduceResult } from '../../result';
import { challengeStateV1Schema } from './schema';
import type { ChallengeConfig, ChallengeEnemyFact, ChallengeParticipantBudget, ChallengeStateV1 } from './types';

/** Alias matching the shared `reducer.ts`'s own `SessionReduceResult` —
 * every Challenge procedure function returns this same shape so callers can
 * treat `reduceSession` and Challenge functions interchangeably. */
export type SessionReduceResult = ReduceResult<SessionEngineStateV1, SessionEvent, SessionRejection>;

/** The content pack's `challenge-round` procedure id — the only
 * `ProcedureState.procedureId` this module ever begins/reads/completes. */
export const CHALLENGE_PROCEDURE_ID = 'challenge-round';

/** Sentinel budget/initiative key for the GM's collective turn resources —
 * matches the convention already fixed by Task 1's schema test fixture
 * (`tests/unit/session/challenge/content.test.ts`'s `budgets: {..., gm: ...}`).
 * Not a tenure id (the GM has none); a stable engine-level key, same spirit
 * as `card-commands.ts`'s `FOOL_CARD_ID`. */
export const CHALLENGE_GM_TENURE_ID = 'gm';

/** The one shared public zone Initiative cards are revealed into. Persists
 * across rounds (cleared, not recreated, at round cleanup). */
export const CHALLENGE_INITIATIVE_ZONE_ID = 'challenge-initiative';

/** A participant's private hand zone id — matches the convention already
 * established by `tests/fixtures/session.ts`'s `fixtureWithHands`
 * (`hand:<ownerUserId>`), reusing `tenureId` as the private zone's owning
 * `UserId` (the pure engine has no notion of a "tenure" beyond an opaque
 * string id; see `types.ts`'s `ChallengeStateV1.participantTenureIds`). */
export function challengeHandZoneId(tenureId: string): string {
	return `hand:${tenureId}`;
}

/** A participant's pre-reveal facedown Initiative zone. Deliberately a
 * distinct zone id from any later "sustained facedown action" zone a future
 * task might add for the same owner (Ch7 "Facedown Cards": "Your Initiative
 * card does not count towards this limit!" — two different game concepts,
 * so two different zones, both legitimately `kind: 'player-facedown'`). */
export function challengeInitiativeFacedownZoneId(tenureId: string): string {
	return `challenge-initiative-facedown:${tenureId}`;
}

/**
 * A GM-controlled enemy fact's pre-reveal facedown Initiative zone (Ch7
 * `challenge-play-initiative`: "The GM will play one Initiative card for
 * each significant character or group of characters they control" —
 * `enemyFacts` is exactly that roster of groups, per the coordinator's
 * concern-2 guidance). Unlike a player's facedown zone this can't live in
 * `state.privateZones` — every entry there is unconditionally tagged
 * `owner: {kind: 'player', ...}` by `zones.ts`'s `listZoneDescriptors`, and
 * the GM is not a player. `state.pendingZones` is the correct generic
 * primitive instead: `visibility: 'hidden'`, GM-only access
 * (`actorMayAccessZone`), and — like every pending zone — the public
 * projection's `pendingZoneCounts` already surfaces an occupied-but-hidden
 * count for it with zero projection-layer changes, the pending-zone analog
 * of a player's facedown "card back."
 */
export function challengeGmInitiativeZoneId(enemyFactId: string): string {
	return `challenge-gm-initiative-facedown:${enemyFactId}`;
}

function reject(code: SessionRejection['code'], message: string): SessionReduceResult {
	return { ok: false, rejection: { code, message } };
}

/** The context every Challenge procedure function takes: the generic
 * session `ReduceContext` (actor/runtime/rng) plus the content-hydrated
 * `ChallengeConfig` (`buildChallengeConfig` in `schema.ts`). Structurally a
 * `ReduceContext`, so it can be passed anywhere `reduceSession` expects one
 * without conversion. */
export interface ChallengeReduceContext extends ReduceContext {
	config: ChallengeConfig;
}

/** Reads and validates the active Challenge state from `state.procedure.gmPrivate`.
 * Returns `undefined` if no `challenge-round` procedure is active or its
 * `gmPrivate` doesn't parse — never throws, so callers can turn this into a
 * proper `SessionRejection` rather than an uncaught error. */
export function readChallengeState(state: SessionEngineStateV1): ChallengeStateV1 | undefined {
	if (!state.procedure || state.procedure.procedureId !== CHALLENGE_PROCEDURE_ID) return undefined;
	const result = challengeStateV1Schema.safeParse(state.procedure.gmPrivate);
	return result.success ? result.data : undefined;
}

/** Validates `challenge` and writes it back as `state.procedure.gmPrivate`.
 * Throws (a reducer bug, not a rejectable user error) if no procedure is
 * active — every caller here only reaches this after confirming one is. */
export function writeChallengeState(state: SessionEngineStateV1, challenge: ChallengeStateV1): SessionEngineStateV1 {
	if (!state.procedure) throw new Error('writeChallengeState: no active procedure');
	const validated = challengeStateV1Schema.parse(challenge);
	return { ...state, procedure: { ...state.procedure, gmPrivate: validated } };
}

/** Fresh per-round budgets: one `{cardsThisTurn:0, actionTaken:false,
 * discards:null}` per participant tenure (O5 — players track no discard
 * budget of their own) plus one `discards:0` entry for the GM (O5/O3 —
 * `gmDiscardsLimitedByHand`). */
export function initialBudgets(tenureIds: readonly string[]): Record<string, ChallengeParticipantBudget> {
	const budgets: Record<string, ChallengeParticipantBudget> = {};
	for (const tenureId of tenureIds) {
		budgets[tenureId] = { cardsThisTurn: 0, actionTaken: false, discards: null };
	}
	budgets[CHALLENGE_GM_TENURE_ID] = { cardsThisTurn: 0, actionTaken: false, discards: 0 };
	return budgets;
}

/** Creates any missing hand/Initiative-facedown zones for `tenureIds`,
 * idempotently (a no-op for already-provisioned participants — used both at
 * setup and again at round cleanup when pending joins are admitted). */
function ensureParticipantZones(state: SessionEngineStateV1, tenureIds: readonly string[]): SessionEngineStateV1 {
	let privateZones = state.privateZones;
	for (const tenureId of tenureIds) {
		const handId = challengeHandZoneId(tenureId);
		const initiativeId = challengeInitiativeFacedownZoneId(tenureId);
		if (!privateZones.some((zone) => zone.id === handId)) {
			privateZones = privateZones.concat({ id: handId, kind: 'player-hand', ownerUserId: tenureId, cards: [] });
		}
		if (!privateZones.some((zone) => zone.id === initiativeId)) {
			privateZones = privateZones.concat({
				id: initiativeId,
				kind: 'player-facedown',
				ownerUserId: tenureId,
				cards: []
			});
		}
	}
	return privateZones === state.privateZones ? state : { ...state, privateZones };
}

function ensureInitiativeZone(state: SessionEngineStateV1): SessionEngineStateV1 {
	if (state.publicZones.some((zone) => zone.id === CHALLENGE_INITIATIVE_ZONE_ID)) return state;
	return {
		...state,
		publicZones: state.publicZones.concat({ id: CHALLENGE_INITIATIVE_ZONE_ID, kind: 'initiative', cards: [] })
	};
}

/** Creates any missing GM-private enemy-Initiative pending zones for
 * `enemyFactIds`, idempotently — mirrors `ensureParticipantZones`, called
 * both at setup and again at round cleanup once the next round's
 * `enemyFacts` are known (a shrinking/growing enemy roster changes which
 * zones are needed; a stale zone for a no-longer-present enemy is simply
 * never placed into or read again). */
function ensureEnemyInitiativeZones(state: SessionEngineStateV1, enemyFactIds: readonly string[]): SessionEngineStateV1 {
	let pendingZones = state.pendingZones;
	for (const enemyFactId of enemyFactIds) {
		const zoneId = challengeGmInitiativeZoneId(enemyFactId);
		if (!pendingZones.some((zone) => zone.id === zoneId)) {
			pendingZones = pendingZones.concat({ id: zoneId, deck: 'major', cards: [] });
		}
	}
	return pendingZones === state.pendingZones ? state : { ...state, pendingZones };
}

/** The GM-supplied inputs that start a Challenge round (Ch7 step 0, "Set the
 * scene" — the GM has already framed the scene and knows who's fighting).
 * Not a `SessionCommand` variant: these values have no home in the generic
 * command vocabulary, which is exactly why they're threaded through this
 * procedure-specific function instead. */
export interface BeginChallengeCommand {
	participantTenureIds: string[];
	enemyFacts: ChallengeEnemyFact[];
}

/**
 * Starts a Challenge round: begins the `challenge-round` procedure, creates
 * each participant's hand/Initiative zones and the shared public Initiative
 * zone, and seeds `ChallengeStateV1` at `stage: 'deal', round: 1` — ready for
 * `dealRound` (`deal.ts`). GM-only (Global Constraint: "GM advances Challenge
 * phases and rounds").
 */
export function beginChallenge(
	state: SessionEngineStateV1,
	command: BeginChallengeCommand,
	context: ChallengeReduceContext
): SessionReduceResult {
	if (context.actor.kind !== 'gm') {
		return reject('not-authorized', 'only the GM may begin a Challenge round');
	}
	if (state.procedure !== null) {
		return reject('illegal-command', 'a procedure is already active');
	}

	const participantTenureIds = [...new Set(command.participantTenureIds)];
	if (participantTenureIds.length === 0) {
		return reject('illegal-command', 'a Challenge round needs at least one participant');
	}

	const beginResult = reduceSession(state, { type: 'begin-procedure', procedureId: CHALLENGE_PROCEDURE_ID }, context);
	if (!beginResult.ok) return beginResult;

	let nextState = ensureParticipantZones(beginResult.state, participantTenureIds);
	nextState = ensureInitiativeZone(nextState);
	nextState = ensureEnemyInitiativeZones(nextState, command.enemyFacts.map((enemy) => enemy.id));

	const challenge: ChallengeStateV1 = {
		schemaVersion: 1,
		stage: 'deal',
		round: 1,
		participantTenureIds,
		pendingJoinTenureIds: [],
		enemyFacts: command.enemyFacts,
		initiativeOrder: [],
		activeTurnIndex: null,
		turnKind: null,
		budgets: initialBudgets(participantTenureIds),
		mulliganUsedThisRound: false,
		modifiers: []
	};
	nextState = writeChallengeState(nextState, challenge);
	assertSessionInvariants(nextState, context.runtime.catalog);

	const event: SessionEvent = {
		kind: 'challenge-begun',
		publicPayload: {
			participantTenureIds,
			round: 1,
			enemyTypeCount: new Set(command.enemyFacts.flatMap((enemy) => enemy.typeIds)).size
		}
	};
	return { ok: true, state: nextState, events: [...beginResult.events, event] };
}

/** Which public zone kinds round cleanup sweeps to discard piles. `played`
 * doesn't exist yet in Task 2 (Task 3 owns plays) — swept generically, by
 * kind, so cleanup keeps working once Task 3 starts populating it, with no
 * change needed here. `revealed`/`inspiration` are deliberately absent (O6:
 * "leaves ... inspiration zones untouched").
 *
 * Sustained `player-facedown`/`player-prepared` zones (a future task's
 * "held" defensive/prepared actions — e.g. Dodge, Aim) are absent from this
 * sweep too, and deliberately never swept by kind at all: rule
 * `challenge-end-the-round` is explicit — "Facedown actions are left
 * facedown" — only hands and the played/Initiative public zones clear at the
 * round boundary. Task 2 never creates a sustained facedown/prepared zone of
 * its own, so there is nothing here for this task to leave alone beyond not
 * reaching for it; this note exists so a later task adding one doesn't need
 * to re-derive the rule. The per-tenure Initiative *placement* zone
 * (`challengeInitiativeFacedownZoneId`, `player-facedown`-kind) and the
 * per-enemy one (`challengeGmInitiativeZoneId`, a GM-only pending zone) are
 * already empty by the time cleanup runs — `revealInitiative` transfers
 * their one card out at reveal — so neither needs an explicit sweep entry
 * either. */
const CLEANUP_SWEPT_PUBLIC_ZONE_KINDS = new Set(['played', 'initiative']);

export interface CleanupRoundOptions {
	/** GM-supplied refreshed enemy facts for the next round (Ch7:
	 * "if the number of enemies decreases, you will draw fewer major arcana
	 * cards" — the GM updates the scene between rounds; recording that update
	 * is this option, not a fabricated automatic mechanic). Carries the
	 * current round's `enemyFacts` forward unchanged when omitted. */
	enemyFacts?: ChallengeEnemyFact[];
}

/**
 * Ends the current round: discards every card in the played/Initiative
 * public zones and every hand (player hands + the GM hand) to its deck's
 * discard pile, resolves any Fool-scheduled reshuffles (`end-round`), clears
 * per-round budgets/modifiers/mulligan-used, admits pending replacement
 * tenures, increments `round`, and leaves `stage: 'deal'` ready for the next
 * `dealRound` call — which recalculates both hand-size targets fresh from
 * whatever `enemyFacts`/`participantTenureIds` now read (O6). GM-only.
 *
 * Deliberately does NOT itself call `dealRound` — round 1 requires a
 * separate explicit `dealRound` call after `beginChallenge`, and every later
 * round follows the identical two-call shape for consistency.
 *
 * Callable once the round has reached `initiative-reveal` or later (`turns`,
 * or an already-in-progress `round-cleanup`) — Task 2 has no turn machinery
 * of its own to require passing through a specific `turns` sub-state first.
 */
export function cleanupRound(
	state: SessionEngineStateV1,
	context: ChallengeReduceContext,
	options: CleanupRoundOptions = {}
): SessionReduceResult {
	if (context.actor.kind !== 'gm') {
		return reject('not-authorized', 'only the GM may end a Challenge round');
	}
	const challenge = readChallengeState(state);
	if (!challenge) return reject('illegal-command', 'no active Challenge round');
	if (!['initiative-reveal', 'turns', 'round-cleanup'].includes(challenge.stage)) {
		return reject('illegal-command', `cannot clean up during stage ${challenge.stage}`);
	}

	let nextState: SessionEngineStateV1 = state;
	const events: SessionEvent[] = [];

	const sweepZoneIds = [
		...nextState.publicZones.filter((zone) => CLEANUP_SWEPT_PUBLIC_ZONE_KINDS.has(zone.kind)).map((zone) => zone.id),
		...challenge.participantTenureIds.map(challengeHandZoneId),
		FIXED_ZONE_IDS.gmHand
	];

	for (const zoneId of sweepZoneIds) {
		const zone = findZoneDescriptor(nextState, zoneId);
		if (!zone) continue;
		for (const cardId of zone.cards.slice()) {
			const discardResult = discardOneCard(nextState, zoneId, cardId, context);
			if (!discardResult.ok) return discardResult;
			nextState = discardResult.state;
			events.push(...discardResult.events);
		}
	}

	const endRoundResult = reduceSession(nextState, { type: 'end-round' }, context);
	if (!endRoundResult.ok) return endRoundResult;
	nextState = endRoundResult.state;
	events.push(...endRoundResult.events);

	const nextParticipantTenureIds = [...challenge.participantTenureIds, ...challenge.pendingJoinTenureIds];
	const nextEnemyFacts = options.enemyFacts ?? challenge.enemyFacts;
	nextState = ensureParticipantZones(nextState, nextParticipantTenureIds);
	nextState = ensureEnemyInitiativeZones(nextState, nextEnemyFacts.map((enemy) => enemy.id));

	const nextChallenge: ChallengeStateV1 = {
		...challenge,
		stage: 'deal',
		round: challenge.round + 1,
		participantTenureIds: nextParticipantTenureIds,
		pendingJoinTenureIds: [],
		enemyFacts: nextEnemyFacts,
		initiativeOrder: [],
		activeTurnIndex: null,
		turnKind: null,
		budgets: initialBudgets(nextParticipantTenureIds),
		mulliganUsedThisRound: false,
		modifiers: []
	};
	nextState = writeChallengeState(nextState, nextChallenge);
	assertSessionInvariants(nextState, context.runtime.catalog);

	events.push({
		kind: 'challenge-round-ended',
		publicPayload: { completedRound: challenge.round, nextRound: nextChallenge.round }
	});

	return { ok: true, state: nextState, events };
}

/** Discards one named card from `zoneId`, routing it to the discard pile of
 * *its own* deck (not the source zone's — `played`/`initiative` zones are
 * `deck: 'both'`, so a card's catalog entry is the only reliable source). */
function discardOneCard(
	state: SessionEngineStateV1,
	zoneId: string,
	cardId: CardId,
	context: ChallengeReduceContext
): SessionReduceResult {
	const entry = context.runtime.catalog[cardId];
	const destinationZoneId = entry?.deck === 'player' ? FIXED_ZONE_IDS.playerDiscard : FIXED_ZONE_IDS.majorDiscard;
	return reduceSession(state, { type: 'discard', sourceZoneId: zoneId, cardId, destinationZoneId }, context);
}

export { ensureParticipantZones, ensureInitiativeZone, reject };
