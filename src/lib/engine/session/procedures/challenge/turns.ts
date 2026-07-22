/**
 * Turn progression, plays, discards, and the GM mulligan for the Challenge
 * procedure (Ch7 step 3 "Take turns" / `challenge-take-turns` /
 * `challenge-minor-actions` / `challenge-gm-hand-size`'s mulligan sidebar).
 * Pure — no UI/DB/network imports (see
 * `tests/unit/session/import-boundaries.test.ts`).
 *
 * ## Budget shape (Increment 3 Task 3 binding override O1)
 *
 * One counter (`cardsThisTurn`) plus an exclusion flag (`actionTaken`), never
 * two independent play/minor-action counters: "You may only spend one card
 * per Initiative turn. If you have performed an action, you cannot also
 * perform a minor action" (`challenge-take-turns`). Every card spend here —
 * a player's action, a player's minor action, or the GM's play — goes
 * through the single `spendCard` helper below, which enforces both rules
 * uniformly: the numeric cap (`cardsPerInitiativeTurn` for players,
 * `gmPlayBudget` for the GM — distinct content knobs, read fresh from
 * `context.config`, never hardcoded) and the action-then-minor-action
 * exclusion. Only a full action sets `actionTaken` — a minor action is not
 * "an action" in the rule's own vocabulary, so it never trips the exclusion
 * itself, only respects it.
 *
 * A discard NEVER touches `cardsThisTurn`/`actionTaken` (Global Constraint —
 * "a discard never consumes a play"). The GM's `discards` counter is
 * round-scoped, not per-turn: `endTurn` resets `cardsThisTurn`/`actionTaken`
 * for whoever's turn is starting but deliberately carries `discards` forward
 * unchanged (`startTurnBudget`) — the GM's hand is one shared pool across
 * every enemy's turn, so "how many cards has the GM discarded this round" is
 * a round-level audit figure, not a per-enemy-turn one. Players never track a
 * discard budget of their own (`discards: null` — `types.ts`).
 *
 * ## Suit rules (O4)
 *
 * A full action never checks suit ("you can use any card to perform any
 * action, regardless of suit" — `challenge-take-turns`). A player's minor
 * action MUST match the action's suit (`challenge-minor-actions`) — the
 * caller supplies `actionSuit` (which fictional minor action they're
 * declaring; the engine does not catalog actions, only enforces the suit
 * match). The GM is exempt from the suit match entirely (the major arcana
 * has no suits) — `applyGmMinorAction` never checks one.
 *
 * ## Turn sequencing
 *
 * `initiativeOrder` (Task 2's `initiative.ts`) is the fixed revealed roster;
 * `activeTurnIndex`/`turnKind` (this module) walk it. `budgets` is keyed by
 * tenure id for players and by the single `CHALLENGE_GM_TENURE_ID` slot for
 * every enemy — the GM controls potentially many `enemyFacts` entries but
 * only ever has ONE turn-budget bucket, reset fresh at the start of
 * whichever enemy's turn is currently active (`budgetKeyFor`).
 */

import { reduceSession } from '../../reducer';
import { FOOL_CARD_ID } from '../../card-commands';
import { assertSessionInvariants } from '../../invariants';
import { FIXED_ZONE_IDS } from '../../zones';
import type { SuitId } from '$lib/types/common';
import type { CardId, SessionEngineStateV1, SessionEvent, SessionRejection } from '$lib/types/session';
import type { ChallengeInitiativeEntry, ChallengeParticipantBudget, ChallengeStateV1, ChallengeTurnKind } from './types';
import { majorCardFrom } from './dooms';
import {
	CHALLENGE_GM_TENURE_ID,
	challengeHandZoneId,
	readChallengeState,
	reject,
	writeChallengeState,
	type ChallengeReduceContext,
	type SessionReduceResult
} from './reducer';

/** The one shared public zone every played card (player action, player minor
 * action, or GM Doom) lands in — `deck: 'both'` by `zones.ts`'s
 * `listZoneDescriptors` (the same declaration `initiative`/`revealed`
 * already use), since both the player and major decks play into it. Task 2
 * deliberately left this zone's creation to this task (`reducer.ts`'s
 * `CLEANUP_SWEPT_PUBLIC_ZONE_KINDS` doc comment: "Task 3 owns plays") — it is
 * swept to discard at round cleanup by that existing sweep (`kind: 'played'`
 * is already in its swept-kinds set). */
export const CHALLENGE_PLAYED_ZONE_ID = 'challenge-played';

/** Idempotently creates the shared played-cards public zone if it doesn't
 * already exist. Exported so `fool.ts` can ensure it before moving the Fool
 * card into it directly (the Fool's own move is not routed through
 * `spendCard`, since it is exempt from the one-card-per-turn budget — see
 * that module). */
export function ensurePlayedZone(state: SessionEngineStateV1): SessionEngineStateV1 {
	if (state.publicZones.some((zone) => zone.id === CHALLENGE_PLAYED_ZONE_ID)) return state;
	return {
		...state,
		publicZones: state.publicZones.concat({ id: CHALLENGE_PLAYED_ZONE_ID, kind: 'played', cards: [] })
	};
}

/** The revealed roster entry whose turn is currently active, or `undefined`
 * before turns begin / once every seat's turn has ended. */
export function activeTurnEntry(challenge: ChallengeStateV1): ChallengeInitiativeEntry | undefined {
	if (challenge.activeTurnIndex === null) return undefined;
	return challenge.initiativeOrder[challenge.activeTurnIndex];
}

/** The `budgets` key `tenureId` spends against this turn: itself for a
 * player tenure, or the shared GM slot for anything else (an `enemyFacts`
 * id) — see the file header. */
function budgetKeyFor(challenge: ChallengeStateV1, tenureId: string): string {
	return challenge.participantTenureIds.includes(tenureId) ? tenureId : CHALLENGE_GM_TENURE_ID;
}

/** A fresh per-turn budget for the participant/GM slot whose turn is
 * starting — resets `cardsThisTurn`/`actionTaken` but carries `discards`
 * forward unchanged (file header: the GM's discard count is round-scoped,
 * not per-turn). */
function startTurnBudget(existing: ChallengeParticipantBudget): ChallengeParticipantBudget {
	return { cardsThisTurn: 0, actionTaken: false, discards: existing.discards };
}

// ---------------------------------------------------------------------------
// beginTurns / endTurn
// ---------------------------------------------------------------------------

/** GM-only: advances `stage` from `'initiative-reveal'` to `'turns'` and
 * activates the first revealed seat, matching every other stage-advance
 * function in this procedure (`beginChallenge`/`dealRound`/`revealInitiative`
 * are all GM-only — Global Constraint: "GM advances Challenge phases and
 * rounds"). */
export function beginTurns(state: SessionEngineStateV1, context: ChallengeReduceContext): SessionReduceResult {
	if (context.actor.kind !== 'gm') {
		return reject('not-authorized', 'only the GM may begin turns');
	}
	const challenge = readChallengeState(state);
	if (!challenge) return reject('illegal-command', 'no active Challenge round');
	if (challenge.stage !== 'initiative-reveal') {
		return reject('illegal-command', `cannot begin turns during stage ${challenge.stage}`);
	}
	if (challenge.initiativeOrder.length === 0) {
		return reject('illegal-command', 'no Initiative order to take turns from');
	}

	const first = challenge.initiativeOrder[0];
	const budgetKey = budgetKeyFor(challenge, first.tenureId);
	const existingBudget = challenge.budgets[budgetKey];
	if (!existingBudget) throw new Error(`beginTurns: no budget tracked for ${budgetKey}`);

	const turnKind: ChallengeTurnKind = first.turnKind ?? 'normal';
	const nextChallenge: ChallengeStateV1 = {
		...challenge,
		stage: 'turns',
		activeTurnIndex: 0,
		turnKind,
		budgets: { ...challenge.budgets, [budgetKey]: startTurnBudget(existingBudget) }
	};
	const nextState = writeChallengeState(state, nextChallenge);
	assertSessionInvariants(nextState, context.runtime.catalog);

	const event: SessionEvent = { kind: 'challenge-turns-begun', publicPayload: { tenureId: first.tenureId, turnKind } };
	return { ok: true, state: nextState, events: [event] };
}

/**
 * Ends the currently active seat's turn and activates the next entry in
 * `initiativeOrder` (which may be a Fool-inserted bonus turn — its
 * `turnKind` is read straight off the entry, see `types.ts`'s
 * `ChallengeInitiativeEntry.turnKind`). Callable by the owning player (their
 * own turn) or the GM (their own enemy's turn, or as an override — the GM
 * has full authority per `card-commands.ts`'s zone-access model). Once every
 * seat has gone, `activeTurnIndex`/`turnKind` reset to `null` — `stage`
 * stays `'turns'`; the GM calls `cleanupRound` (Task 2) when ready, exactly
 * as that function's own doc comment already documents ("Task 2 has no turn
 * machinery of its own to require passing through a specific `turns`
 * sub-state first").
 */
export function endTurn(state: SessionEngineStateV1, context: ChallengeReduceContext): SessionReduceResult {
	const challenge = readChallengeState(state);
	if (!challenge) return reject('illegal-command', 'no active Challenge round');
	if (challenge.stage !== 'turns') return reject('illegal-command', `cannot end a turn during stage ${challenge.stage}`);
	if (challenge.activeTurnIndex === null) return reject('illegal-command', 'turns have not begun');

	const entry = challenge.initiativeOrder[challenge.activeTurnIndex];
	if (!entry) return reject('illegal-command', 'no active turn to end');

	if (challenge.participantTenureIds.includes(entry.tenureId)) {
		const owner = challenge.tenureOwners[entry.tenureId];
		if (context.actor.kind === 'player' && context.actor.userId !== owner) {
			return reject('not-authorized', 'a player may only end their own turn');
		}
	} else if (context.actor.kind !== 'gm') {
		return reject('not-authorized', 'only the GM may end an enemy turn');
	}

	const nextIndex = challenge.activeTurnIndex + 1;
	if (nextIndex >= challenge.initiativeOrder.length) {
		const nextChallenge: ChallengeStateV1 = { ...challenge, activeTurnIndex: null, turnKind: null };
		const nextState = writeChallengeState(state, nextChallenge);
		assertSessionInvariants(nextState, context.runtime.catalog);
		const event: SessionEvent = { kind: 'challenge-turns-completed', publicPayload: { round: challenge.round } };
		return { ok: true, state: nextState, events: [event] };
	}

	const nextEntry = challenge.initiativeOrder[nextIndex];
	const budgetKey = budgetKeyFor(challenge, nextEntry.tenureId);
	const existingBudget = challenge.budgets[budgetKey];
	if (!existingBudget) throw new Error(`endTurn: no budget tracked for ${budgetKey}`);
	const nextTurnKind: ChallengeTurnKind = nextEntry.turnKind ?? 'normal';

	const nextChallenge: ChallengeStateV1 = {
		...challenge,
		activeTurnIndex: nextIndex,
		turnKind: nextTurnKind,
		budgets: { ...challenge.budgets, [budgetKey]: startTurnBudget(existingBudget) }
	};
	const nextState = writeChallengeState(state, nextChallenge);
	assertSessionInvariants(nextState, context.runtime.catalog);

	const event: SessionEvent = {
		kind: 'challenge-turn-advanced',
		publicPayload: { fromTenureId: entry.tenureId, toTenureId: nextEntry.tenureId, turnKind: nextTurnKind }
	};
	return { ok: true, state: nextState, events: [event] };
}

// ---------------------------------------------------------------------------
// Turn/authorization guards
// ---------------------------------------------------------------------------

/** Resolves and validates that it is currently `tenureId`'s own active turn,
 * returning the live `ChallengeStateV1` on success or a `SessionRejection`
 * on failure — never throws on caller input. Authorization mirrors
 * `initiative.ts`'s `placeInitiative`: a player may only act for their OWN
 * tenure (resolved through `tenureOwners`, never by comparing
 * `actor.userId` to the tenure id directly — O7), while the GM has full
 * authority and may act on any tenure's behalf. */
export function requirePlayerTurn(
	state: SessionEngineStateV1,
	tenureId: string,
	context: ChallengeReduceContext
): ChallengeStateV1 | SessionRejection {
	const challenge = readChallengeState(state);
	if (!challenge) return { code: 'illegal-command', message: 'no active Challenge round' };
	if (challenge.stage !== 'turns') return { code: 'illegal-command', message: `cannot act during stage ${challenge.stage}` };
	if (!challenge.participantTenureIds.includes(tenureId)) {
		return { code: 'illegal-command', message: `${tenureId} is not an active Challenge participant` };
	}
	const owner = challenge.tenureOwners[tenureId];
	if (context.actor.kind === 'player' && context.actor.userId !== owner) {
		return { code: 'not-authorized', message: 'a player may only act on their own turn' };
	}
	const entry = activeTurnEntry(challenge);
	if (!entry || entry.tenureId !== tenureId) {
		return { code: 'illegal-command', message: `it is not ${tenureId}'s turn` };
	}
	return challenge;
}

/** The GM-side equivalent of `requirePlayerTurn`: validates it is currently
 * an ENEMY seat's turn (not a player's), and that the actor is the GM. */
function requireGmTurn(state: SessionEngineStateV1, context: ChallengeReduceContext): ChallengeStateV1 | SessionRejection {
	if (context.actor.kind !== 'gm') return { code: 'not-authorized', message: 'only the GM may act for an enemy' };
	const challenge = readChallengeState(state);
	if (!challenge) return { code: 'illegal-command', message: 'no active Challenge round' };
	if (challenge.stage !== 'turns') return { code: 'illegal-command', message: `cannot act during stage ${challenge.stage}` };
	const entry = activeTurnEntry(challenge);
	if (!entry) return { code: 'illegal-command', message: 'no active turn' };
	if (challenge.participantTenureIds.includes(entry.tenureId)) {
		return { code: 'illegal-command', message: "it is a player's turn, not an enemy's" };
	}
	return challenge;
}

export function isRejection(value: ChallengeStateV1 | SessionRejection): value is SessionRejection {
	return 'code' in value;
}

// ---------------------------------------------------------------------------
// spendCard — the one place a card leaves a hand to become an action
// ---------------------------------------------------------------------------

export interface SpendCardOptions {
	budgetKey: string;
	handZoneId: string;
	cardId: CardId;
	actionKind: 'action' | 'minor-action';
	/** Present only for a player's minor action (O4) — the GM never carries
	 * this (suit-exempt), and a full action never checks suit either.
	 * Increment 3 Task 4's `challenge-aim` is the one FULL action that also
	 * carries this: Aim is content-tagged `suit: 'swords'` (Ch9 "Bow": "Aim is
	 * a Swords action"), a genuine exception to "any card for any action" that
	 * the content pack states explicitly rather than this module inventing it. */
	actionSuit?: SuitId;
	cap: number;
	eventKind: string;
	extraPublicPayload: Record<string, unknown>;
	/**
	 * Where the spent card lands. Defaults to `CHALLENGE_PLAYED_ZONE_ID` when
	 * omitted (every Task 3 call site) — Increment 3 Task 4 generalizes this
	 * so `challenge-guard` (replace-Initiative) can spend into
	 * `CHALLENGE_INITIATIVE_ZONE_ID` and `challenge-aim`/Guardian Angel's
	 * cast leg can spend into a private facedown/staging zone, all through
	 * this SAME budget/cap choke point (O7) rather than a parallel counter.
	 * When set, the CALLER is responsible for ensuring the zone already
	 * exists (`ensurePlayedZone` only auto-creates the default).
	 */
	destinationZoneId?: string;
}

/** Shared legality/mutation core for every card-spending turn action
 * (`applyPlayerAction`, `applyPlayerMinorAction`, `applyGmPlay`,
 * `applyGmMinorAction`, and — via `fool.ts`'s reuse of `applyPlayerAction` —
 * the Fool's paired card). Enforces the numeric cap and the action/minor-
 * action exclusion (file header), then moves the card into the shared
 * `CHALLENGE_PLAYED_ZONE_ID` public zone through the ordinary `reduceSession`
 * `'play'` command (so the same zone-legality/deck-check/invariant pipeline
 * every other procedure uses still runs), and finally relabels that generic
 * `card-played` event with `eventKind` — a Challenge-specific kind carrying
 * turn/budget context the generic engine has no vocabulary for (which
 * tenure/the GM, action vs minor action, Doom tier) — without inventing a
 * second, duplicate event alongside it. */
export function spendCard(
	state: SessionEngineStateV1,
	challenge: ChallengeStateV1,
	options: SpendCardOptions,
	context: ChallengeReduceContext
): SessionReduceResult {
	const budget = challenge.budgets[options.budgetKey];
	if (!budget) throw new Error(`spendCard: no budget tracked for ${options.budgetKey}`);

	// The Fool is never spent as an ordinary action or minor action — Ch7 is
	// explicit that it is "always played in conjunction with another card"
	// (`challenge-the-fool`). `fool.ts`'s `playFool` is the only legal path
	// for it; a lone Fool reaching here (via `applyPlayerAction`,
	// `applyPlayerMinorAction`, or any future caller of `spendCard`) is
	// rejected outright, independent of budget/suit state. `fool.ts` itself
	// never triggers this — it validates the paired card is NOT the Fool
	// before ever calling `applyPlayerAction` for it.
	if (options.cardId === FOOL_CARD_ID) {
		return reject('illegal-command', 'the Fool cannot be played as an ordinary action or minor action — play it via the paired-play command instead');
	}

	if (options.actionKind === 'minor-action' && budget.actionTaken) {
		return reject('illegal-command', 'cannot perform a minor action after taking an action this turn');
	}
	if (budget.cardsThisTurn >= options.cap) {
		return reject('illegal-command', 'no card budget remaining this turn');
	}
	if (options.actionSuit !== undefined) {
		const cardEntry = context.runtime.catalog[options.cardId];
		if (!cardEntry) return reject('content-mismatch', `unrecognized card referenced for a minor action`);
		if (cardEntry.suit !== options.actionSuit) {
			return reject('illegal-command', `card suit does not match the required ${options.actionSuit} suit for this action`);
		}
	}

	// The default destination (`CHALLENGE_PLAYED_ZONE_ID`) is auto-created
	// here exactly as Task 3 always did; a caller-supplied `destinationZoneId`
	// (Increment 3 Task 4) is that caller's own responsibility to have already
	// ensured (`applyGuard`'s target is `beginChallenge`'s own Initiative
	// zone; `prepareAim`/`applyGuardianAngel` ensure their own facedown/
	// staging zone immediately before calling this).
	const destinationZoneId = options.destinationZoneId ?? CHALLENGE_PLAYED_ZONE_ID;
	const ensuredState = options.destinationZoneId === undefined ? ensurePlayedZone(state) : state;
	const moveResult = reduceSession(
		ensuredState,
		{ type: 'play', sourceZoneId: options.handZoneId, cardId: options.cardId, destinationZoneId },
		context
	);
	if (!moveResult.ok) return moveResult;

	const nextBudget: ChallengeParticipantBudget = {
		...budget,
		cardsThisTurn: budget.cardsThisTurn + 1,
		actionTaken: options.actionKind === 'action' ? true : budget.actionTaken
	};
	const nextChallenge: ChallengeStateV1 = {
		...challenge,
		budgets: { ...challenge.budgets, [options.budgetKey]: nextBudget }
	};
	const nextState = writeChallengeState(moveResult.state, nextChallenge);
	assertSessionInvariants(nextState, context.runtime.catalog);

	const events: SessionEvent[] = moveResult.events.map((event) => ({
		kind: options.eventKind,
		publicPayload: { ...(event.publicPayload as Record<string, unknown>), ...options.extraPublicPayload },
		...(event.privatePayloads ? { privatePayloads: event.privatePayloads } : {})
	}));

	return { ok: true, state: nextState, events };
}

// ---------------------------------------------------------------------------
// Player plays
// ---------------------------------------------------------------------------

/** Plays `cardId` from `tenureId`'s hand as their turn's full action. No
 * suit constraint (O4: "you can use any card to perform any action,
 * regardless of suit"). */
export function applyPlayerAction(
	state: SessionEngineStateV1,
	tenureId: string,
	cardId: CardId,
	context: ChallengeReduceContext
): SessionReduceResult {
	const guard = requirePlayerTurn(state, tenureId, context);
	if (isRejection(guard)) return { ok: false, rejection: guard };
	const challenge = guard;

	return spendCard(
		state,
		challenge,
		{
			budgetKey: tenureId,
			handZoneId: challengeHandZoneId(tenureId),
			cardId,
			actionKind: 'action',
			cap: context.config.cardsPerInitiativeTurn,
			eventKind: 'challenge-card-played',
			extraPublicPayload: { tenureId, actionKind: 'action' }
		},
		context
	);
}

/** Plays `cardId` from `tenureId`'s hand as a minor action declaring
 * `actionSuit` — the card's own suit MUST match (O4:
 * `challenge-minor-actions`), and this is rejected outright once the
 * participant has already taken a full action this turn, or during a
 * Fool-granted extra turn (O5/Ch7: "no minor actions" on that bonus turn). */
export function applyPlayerMinorAction(
	state: SessionEngineStateV1,
	tenureId: string,
	cardId: CardId,
	actionSuit: SuitId,
	context: ChallengeReduceContext
): SessionReduceResult {
	const guard = requirePlayerTurn(state, tenureId, context);
	if (isRejection(guard)) return { ok: false, rejection: guard };
	const challenge = guard;

	if (challenge.turnKind === 'fool-extra') {
		return reject('illegal-command', 'a Fool extra turn grants no minor actions');
	}

	return spendCard(
		state,
		challenge,
		{
			budgetKey: tenureId,
			handZoneId: challengeHandZoneId(tenureId),
			cardId,
			actionKind: 'minor-action',
			actionSuit,
			cap: context.config.cardsPerInitiativeTurn,
			eventKind: 'challenge-minor-action-played',
			extraPublicPayload: { tenureId, actionKind: 'minor-action', actionSuit }
		},
		context
	);
}

// ---------------------------------------------------------------------------
// GM plays / discards / mulligan
// ---------------------------------------------------------------------------

/** Plays `cardId` from `gmHand` as the currently-active enemy seat's Doom
 * (`challenge-play-gm-doom`). Tags the event with the card's Doom tier/value
 * parity (`dooms.ts`'s `majorCardFrom` — read from the catalog, never
 * hardcoded — O2) so content-backed denizen abilities (Task 4) can react to
 * what was actually played without re-deriving it. */
export function applyGmPlay(state: SessionEngineStateV1, cardId: CardId, context: ChallengeReduceContext): SessionReduceResult {
	const guard = requireGmTurn(state, context);
	if (isRejection(guard)) return { ok: false, rejection: guard };
	const challenge = guard;

	const majorCard = majorCardFrom(context.runtime.catalog, cardId);

	return spendCard(
		state,
		challenge,
		{
			budgetKey: CHALLENGE_GM_TENURE_ID,
			handZoneId: FIXED_ZONE_IDS.gmHand,
			cardId,
			actionKind: 'action',
			cap: context.config.gmPlayBudget,
			eventKind: 'challenge-card-played',
			extraPublicPayload: {
				tenureId: CHALLENGE_GM_TENURE_ID,
				actionKind: 'action',
				doomTier: majorCard?.doomTier,
				valueParity: majorCard?.valueParity
			}
		},
		context
	);
}

/** Plays `cardId` from `gmHand` as the currently-active enemy seat's minor
 * action. Suit-exempt (O4: "Because the GM uses the major arcana ... they
 * ignore the requirement that the card played must match the action's
 * suit"). */
export function applyGmMinorAction(state: SessionEngineStateV1, cardId: CardId, context: ChallengeReduceContext): SessionReduceResult {
	const guard = requireGmTurn(state, context);
	if (isRejection(guard)) return { ok: false, rejection: guard };
	const challenge = guard;

	return spendCard(
		state,
		challenge,
		{
			budgetKey: CHALLENGE_GM_TENURE_ID,
			handZoneId: FIXED_ZONE_IDS.gmHand,
			cardId,
			actionKind: 'minor-action',
			cap: context.config.gmPlayBudget,
			eventKind: 'challenge-minor-action-played',
			extraPublicPayload: { tenureId: CHALLENGE_GM_TENURE_ID, actionKind: 'minor-action' }
		},
		context
	);
}

/** Discards `cardId` from `gmHand` to the major discard pile. Available any
 * time during `'turns'` (not gated to a specific enemy's active turn — the
 * GM's hand is one shared pool across every enemy) and NEVER touches
 * `cardsThisTurn`/`actionTaken` (Global Constraint — "a discard never
 * consumes a play"), only the separate, round-scoped `discards` counter
 * (`gmDiscardsLimitedByHand`: limited only by what's still in hand, not a
 * fixed number, so this never rejects on a budget cap). */
export function applyGmDiscard(state: SessionEngineStateV1, cardId: CardId, context: ChallengeReduceContext): SessionReduceResult {
	if (context.actor.kind !== 'gm') return reject('not-authorized', 'only the GM may discard from the GM hand');
	const challenge = readChallengeState(state);
	if (!challenge) return reject('illegal-command', 'no active Challenge round');
	if (challenge.stage !== 'turns') return reject('illegal-command', `cannot discard during stage ${challenge.stage}`);

	const discardResult = reduceSession(
		state,
		{ type: 'discard', sourceZoneId: FIXED_ZONE_IDS.gmHand, cardId, destinationZoneId: FIXED_ZONE_IDS.majorDiscard },
		context
	);
	if (!discardResult.ok) return discardResult;

	const budget = challenge.budgets[CHALLENGE_GM_TENURE_ID];
	if (!budget) throw new Error('applyGmDiscard: no budget tracked for the GM');
	const nextBudget: ChallengeParticipantBudget = { ...budget, discards: (budget.discards ?? 0) + 1 };
	const nextChallenge: ChallengeStateV1 = {
		...challenge,
		budgets: { ...challenge.budgets, [CHALLENGE_GM_TENURE_ID]: nextBudget }
	};
	const nextState = writeChallengeState(discardResult.state, nextChallenge);
	assertSessionInvariants(nextState, context.runtime.catalog);

	const events: SessionEvent[] = discardResult.events.map((event) => ({ ...event, kind: 'challenge-card-discarded' }));
	return { ok: true, state: nextState, events };
}

/**
 * The GM mulligan (Ch7 sidebar, Increment 3 Task 3 binding override O3):
 * elective GM discretion with NO numeric threshold — gated only on stage and
 * on not having been used yet this round. Discards the entire `gmHand` to
 * the major discard pile and redraws the same count (`card-commands.ts`'s
 * shared `'mulligan'` command already does exactly this — discard-all,
 * redraw-same-count, reshuffle-if-needed — so this composes it rather than
 * reimplementing it), leaving every in-play card (Initiative placements,
 * already-played cards) untouched since only the `gmHand` zone is named.
 *
 * A mulligan against an ALREADY-EMPTY `gmHand` is a legal no-op at the
 * shared engine layer (`handleMulligan` discards/redraws zero cards), but it
 * is NOT a meaningful use of the GM's once-per-round elective — there was no
 * "hand that's mostly greater dooms" to mulligan away. `mulliganUsedThisRound`
 * is therefore only set when there was actually something to discard;
 * calling this against an empty hand still succeeds (and is still reported
 * to the caller) but leaves the real elective available for later in the
 * round.
 */
export function applyGmMulligan(state: SessionEngineStateV1, context: ChallengeReduceContext): SessionReduceResult {
	if (context.actor.kind !== 'gm') return reject('not-authorized', 'only the GM may mulligan');
	const challenge = readChallengeState(state);
	if (!challenge) return reject('illegal-command', 'no active Challenge round');
	if (challenge.stage !== 'turns') return reject('illegal-command', `cannot mulligan during stage ${challenge.stage}`);
	if (challenge.mulliganUsedThisRound) {
		return reject('illegal-command', 'the GM mulligan has already been used this round');
	}

	const handWasEmpty = state.gmHand.length === 0;

	const mulliganResult = reduceSession(state, { type: 'mulligan', zoneId: FIXED_ZONE_IDS.gmHand }, context);
	if (!mulliganResult.ok) return mulliganResult;

	const nextChallenge: ChallengeStateV1 = { ...challenge, mulliganUsedThisRound: !handWasEmpty };
	const nextState = writeChallengeState(mulliganResult.state, nextChallenge);
	assertSessionInvariants(nextState, context.runtime.catalog);

	return { ok: true, state: nextState, events: mulliganResult.events };
}
