/**
 * Types for the Challenge procedure — His Majesty the Worm's guided combat
 * round (Ch7, "The Challenge Phase"). Shapes only: numeric budgets and
 * formula parameters are content-driven (hydrated from the content pack by
 * `schema.ts`'s `buildChallengeConfig`, never hardcoded here — project rule:
 * "All game data changes go in content-pack JSON, not application code").
 * Pure — no UI/DB/network imports (see
 * `tests/unit/session/import-boundaries.test.ts`).
 *
 * This module defines the runtime shapes only. Dealing, initiative, turns,
 * and hand-size calculation are later Challenge tasks.
 */

import type { CardId } from '$lib/types/session';

/** Every stage a Challenge round passes through, in order. */
export type ChallengeStage =
	| 'setup'
	| 'deal'
	| 'initiative-placement'
	| 'initiative-reveal'
	| 'turns'
	| 'round-cleanup'
	| 'complete';

/**
 * The `gm-hand-size` formula's parameters, mirrored verbatim from the
 * content pack's formula catalog. Flat — no `sizeAdjustments`/
 * `threatAdjustments` maps (those never shipped; see the Increment 3 Task 1
 * binding overrides).
 */
export interface GmHandFormulaParams {
	base: number;
	perEnemyType: number;
	enemiesOutnumberAdventurers: number;
	enemiesDoubleAdventurers: number;
	perLargerThanHumanEnemy: number;
	eliteEnemyPresent: number;
	dungeonLordPresent: number;
}

/**
 * The Fool's fixed interrupt behavior (Ch7 "The Fool"). Every field is a
 * rules constant rather than a per-table tunable, hence the literal types —
 * mirrors the content pack's `challenge-round.params.fool` block.
 */
export interface ChallengeFoolConfig {
	pairedPlayRequired: true;
	grantsExtraTurn: true;
	extraTurnMinorActions: 0;
	reshuffleBoundary: 'end-round';
}

/**
 * Validated, content-hydrated configuration for a Challenge round. Built by
 * `buildChallengeConfig` (`schema.ts`) from the content pack's
 * `player-hand-size`/`gm-hand-size` formulas and the `challenge-round`
 * procedure's `params` block — never authored as TypeScript literals.
 *
 * Deliberately omits a Doom-tier boundary: that already ships as
 * `tarot.doomTiers` (`DoomTierConfig` in `src/lib/types/content-pack.ts`),
 * and every Doom-tier predicate must read that directly rather than a
 * duplicate copy here.
 *
 * Deliberately omits a numeric mulligan threshold: the book states GM
 * mulligan-on-mostly-greater-dooms as elective discretion with no number
 * (Ch7 sidebar), so it is modeled as a used/not-used flag on
 * `ChallengeStateV1.mulliganUsedThisRound`, not a fabricated rule constant.
 */
export interface ChallengeConfig {
	schemaVersion: 1;
	/** From the `player-hand-size` formula's `base` param. */
	playerBaseHandSize: number;
	/** From the `gm-hand-size` formula's params, verbatim. */
	gmHandFormula: GmHandFormulaParams;
	/** "You may only spend one card per Initiative turn" (`challenge-take-turns`). */
	cardsPerInitiativeTurn: number;
	/** "If you have performed an action, you cannot also perform a minor
	 * action" (`challenge-take-turns`) — interrupt actions (the Fool) are
	 * exempt from this exclusion. */
	actionExcludesMinorAction: true;
	gmPlayBudget: number;
	/** A discard never consumes a play; multiple discards up to held cards
	 * are allowed (Global Constraint). */
	gmDiscardsLimitedByHand: true;
	fool: ChallengeFoolConfig;
}

/**
 * One enemy fact entered by the GM at round start. `size`/`threat`/
 * `typeIds` are content lookup ids the (later) GM hand formula and typed
 * Doom predicates key off of — validated against content, not enumerated
 * here.
 *
 * An entry is **one significant character OR one group of characters**
 * (`challenge-play-initiative`: "The GM will play one Initiative card for
 * each significant character or group of characters they control") —
 * `count` is how many individual enemies that entry represents (>= 1). Two
 * consumers read this differently and both are correct: Initiative
 * (`initiative.ts`'s `placeGmInitiative`) needs one card per *entry*
 * regardless of `count` — twelve imps entered as one group still needs only
 * one card, which is the entire point of the "or group" clause. The GM
 * hand-size formula (`deal.ts`'s `calculateGmHandSize`) needs the total
 * *headcount* — `enemies.length` alone undercounts a grouped entry, so it
 * sums every entry's `count` instead. Distinct-type counting and the
 * elite/dungeon-lord presence flags are unaffected by `count` (a type is
 * still counted once no matter how many individuals share it; presence is
 * presence, not a per-head bonus) — only the outnumber/double thresholds and
 * `perLargerThanHumanEnemy` are headcount-weighted. Do not represent "twelve
 * imps" as twelve separate entries to route around this — that was tried and
 * is exactly the shape this field exists to prevent (Increment 3 Task 2
 * coordinator follow-up).
 */
export interface ChallengeEnemyFact {
	id: string;
	size: string;
	threat: string;
	typeIds: string[];
	/** How many individual enemies this entry (one significant character or
	 * one group) represents. Always >= 1. */
	count: number;
}

/** One seat in the revealed Initiative order. */
export interface ChallengeInitiativeEntry {
	tenureId: string;
	cardZoneId: string;
	revealed: boolean;
	/**
	 * Present only on a bonus turn `fool.ts`'s `playFool` inserts immediately
	 * after the current seat (Ch7 "The Fool": "drawing the Fool allows you to
	 * take two turns (but no minor actions) during a round") — absent (read as
	 * `'normal'`) on every entry `initiative.ts`'s `revealInitiative` produces.
	 * Additive field (Increment 3 Task 3): lets the turn loop
	 * (`turns.ts`'s `endTurn`) carry the inserted turn's kind without a
	 * parallel structure duplicating `initiativeOrder` itself.
	 */
	turnKind?: ChallengeTurnKind;
	/**
	 * The specific card currently seated here, once revealed. Absent
	 * pre-reveal (mirrors `revealed: false`) — `initiative.ts`'s
	 * `revealInitiative` is the only writer that sets it, alongside flipping
	 * `revealed` to `true`. Additive field (Increment 3 Task 4): without it,
	 * nothing in `ChallengeStateV1` records WHICH card seats a given tenure
	 * once every revealed entry shares the same `cardZoneId` (the one shared
	 * public Initiative zone) — `modifiers.ts`'s `applyGuard` needs to name the
	 * exact old card to discard when swapping in a new one (Ch7:552-554), and
	 * a flat zone-cards array alone can't answer "which card is THIS tenure's"
	 * once several tenures' cards sit in the same zone.
	 */
	cardId?: CardId;
}

/**
 * Per-participant turn budget. One counter plus an exclusion flag (not two
 * independent play/minor-action counters) because the rule is genuinely
 * exclusive: "You may only spend one card per Initiative turn. If you have
 * performed an action, you cannot also perform a minor action"
 * (`challenge-take-turns`). Two counters would allow illegally spending both
 * in the same turn. `discards` is tracked separately and is never
 * decremented by a play (Global Constraint) — `null` when the actor (a
 * player) has no discard budget of their own to track.
 */
export interface ChallengeParticipantBudget {
	cardsThisTurn: number;
	actionTaken: boolean;
	discards: number | null;
}

/** Which kind of turn is active. A Fool interrupt grants one `fool-extra`
 * turn immediately after the current turn; that turn is exempt from the
 * one-card limit but grants no minor actions. */
export type ChallengeTurnKind = 'normal' | 'fool-extra';

/**
 * Runtime instance of a content-defined Challenge modifier (the `challenge-*`
 * entries in the content pack's `modifiers` catalog — Black Honey, Stun,
 * Brainfever, Counsel, Guardian Angel, Aim, Guard) currently in effect.
 *
 * Deliberately minimal: this task defines only the shape needed to persist
 * one instance in state. The typed commands and behavior that create,
 * resolve, and expire these belong to a later Challenge task.
 */
export interface ChallengeModifierState {
	/** Unique per instance — not the content modifier id, which repeats
	 * across instances (e.g. two Guardian Angels in play at once). */
	instanceId: string;
	/** The content pack's `SessionModifierDefinition.id`, e.g.
	 * `challenge-guardian-angel`. */
	modifierId: string;
	ownerTenureId: string;
	targetTenureId?: string;
	status: 'pending' | 'active' | 'resolved' | 'expired';
	/** Remaining uses for modifiers with a per-round/per-instance cap (e.g.
	 * Counsel's `maxUsesPerRound`); absent when not applicable. */
	usesRemaining?: number;
	/**
	 * The specific card this instance is bound to, when the modifier's
	 * "cumulative" nature (Guardian Angel: "cumulative" — Ch11) means a target
	 * can hold MORE THAN ONE such instance's card at once. Without this, a
	 * later resolve/consume step naming a `cardId` (Increment 3 Task 4 review,
	 * Important 2) has no way to identify WHICH of possibly several active
	 * instances that card belongs to. Absent for modifiers that never
	 * stack this way (Counsel, Black Honey).
	 */
	cardId?: string;
}

/**
 * The complete state of an in-progress Challenge round. Owned by the
 * Challenge procedure; the shared session engine's `ProcedureState.gmPrivate`
 * / public projection carry only what each viewer is allowed to see (later
 * Challenge tasks).
 */
export interface ChallengeStateV1 {
	schemaVersion: 1;
	stage: ChallengeStage;
	round: number;
	participantTenureIds: string[];
	/**
	 * `tenureId -> owning userId`. A tenure (Increment 1) is an adventurer's
	 * attachment to a campaign membership — it is NOT a user id, and must
	 * never be compared against `SessionActor.userId` directly. Every id in
	 * `participantTenureIds` must have an entry here; `beginChallenge`/
	 * `cleanupRound` reject a roster with a missing owner rather than let a
	 * tenure silently become unauthorizable or its private zones misowned.
	 *
	 * Keyed by tenure rather than user because on death the same user
	 * attaches a NEW tenure (a replacement adventurer) — keying by tenure
	 * keeps the dead adventurer's private Challenge zones addressable
	 * separately from their replacement's, which Task 5 needs to redact/
	 * remove independently of the user's other (living) tenures.
	 */
	tenureOwners: Record<string, string>;
	pendingJoinTenureIds: string[];
	enemyFacts: ChallengeEnemyFact[];
	initiativeOrder: ChallengeInitiativeEntry[];
	/** Groups of two-or-more `initiativeOrder` ids that share the same
	 * revealed card value — Ch7 "Tied Initiative" makes resolving a tie a
	 * table decision, not an engine ruling (see `initiative.ts`'s file header
	 * doc comment). Carried here, not only on the `challenge-initiative-
	 * revealed` event's payload, so a later reader of *state* (Task 3's turn
	 * loop, Task 6's UI) still sees which seats are tied without replaying
	 * the event log. Empty before `revealInitiative` runs; reset to `[]` at
	 * each round's cleanup alongside `initiativeOrder`. */
	tiedGroups: string[][];
	activeTurnIndex: number | null;
	turnKind: ChallengeTurnKind | null;
	budgets: Record<string, ChallengeParticipantBudget>;
	/** Elective, once-per-round GM discretion (Ch7 sidebar: mulligan a hand
	 * that's "mostly" greater dooms). No numeric threshold exists in the
	 * book, so this is a used/not-used flag rather than a fabricated count. */
	mulliganUsedThisRound: boolean;
	modifiers: ChallengeModifierState[];
}
