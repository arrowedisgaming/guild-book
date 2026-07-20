/**
 * Types for the Challenge procedure — His Majesty the Worm's guided combat
 * round (Ch7, "The Challenge Phase"). Shapes only: numeric budgets and
 * formula parameters are content-driven (hydrated from the content pack by
 * `schema.ts`'s `buildChallengeConfig`, never hardcoded here — CLAUDE.md:
 * "All game data changes go in content-pack JSON, not application code").
 * Pure — no UI/DB/network imports (see
 * `tests/unit/session/import-boundaries.test.ts`).
 *
 * This module defines the runtime shapes only. Dealing, initiative, turns,
 * and hand-size calculation are later Challenge tasks.
 */

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

/** One enemy fact entered by the GM at round start. `size`/`threat`/
 * `typeIds` are content lookup ids the (later) GM hand formula and typed
 * Doom predicates key off of — validated against content, not enumerated
 * here. */
export interface ChallengeEnemyFact {
	id: string;
	size: string;
	threat: string;
	typeIds: string[];
}

/** One seat in the revealed Initiative order. */
export interface ChallengeInitiativeEntry {
	tenureId: string;
	cardZoneId: string;
	revealed: boolean;
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
	pendingJoinTenureIds: string[];
	enemyFacts: ChallengeEnemyFact[];
	initiativeOrder: ChallengeInitiativeEntry[];
	activeTurnIndex: number | null;
	turnKind: ChallengeTurnKind | null;
	budgets: Record<string, ChallengeParticipantBudget>;
	/** Elective, once-per-round GM discretion (Ch7 sidebar: mulligan a hand
	 * that's "mostly" greater dooms). No numeric threshold exists in the
	 * book, so this is a used/not-used flag rather than a fabricated count. */
	mulliganUsedThisRound: boolean;
	modifiers: ChallengeModifierState[];
}
