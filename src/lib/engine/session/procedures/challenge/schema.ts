/**
 * Zod validation for the Challenge procedure's content-hydrated config and
 * runtime state. Mirrors `types.ts` — keep the two in lockstep. Pure — no
 * UI/DB/network imports (see `tests/unit/session/import-boundaries.test.ts`).
 */

import { z } from 'zod';
import type { TarotFormulaDefinition, TarotProcedureDefinition } from '$lib/types/content-pack';
import type { ChallengeConfig, ChallengeStateV1 } from './types';

const nonNegativeInt = z.number().int().nonnegative();
const tenureId = z.string().trim().min(1);

// ---------------------------------------------------------------------------
// ChallengeConfig
// ---------------------------------------------------------------------------

/** Mirrors `GmHandFormulaParams` — the `gm-hand-size` formula's params,
 * shipped flat in the content pack. Rejects negative counts. */
export const gmHandFormulaParamsSchema = z
	.object({
		base: nonNegativeInt,
		perEnemyType: nonNegativeInt,
		enemiesOutnumberAdventurers: nonNegativeInt,
		enemiesDoubleAdventurers: nonNegativeInt,
		perLargerThanHumanEnemy: nonNegativeInt,
		eliteEnemyPresent: nonNegativeInt,
		dungeonLordPresent: nonNegativeInt
	})
	.strict();

const playerHandSizeParamsSchema = z.object({ base: nonNegativeInt }).strict();

/** Mirrors `ChallengeFoolConfig` — fixed rule constants, so every field is a
 * literal rather than a bare primitive. */
export const challengeFoolConfigSchema = z
	.object({
		pairedPlayRequired: z.literal(true),
		grantsExtraTurn: z.literal(true),
		extraTurnMinorActions: z.literal(0),
		reshuffleBoundary: z.literal('end-round')
	})
	.strict();

/** The `challenge-round` procedure's content-pack `params` block (see
 * `static/content-packs/hmtw/tarot-procedures.json`, sourced from
 * `challenge-take-turns` / `challenge-the-fool` / the Global Constraint on
 * separate GM play/discard budgets). */
export const challengeRoundParamsSchema = z
	.object({
		cardsPerInitiativeTurn: z.number().int().positive(),
		actionExcludesMinorAction: z.literal(true),
		gmPlayBudget: nonNegativeInt,
		gmDiscardsLimitedByHand: z.literal(true),
		fool: challengeFoolConfigSchema
	})
	.strict();

/** Mirrors `ChallengeConfig`. `.strict()` so a stray content field fails
 * loudly at load rather than silently vanishing. */
export const challengeConfigSchema = z
	.object({
		schemaVersion: z.literal(1),
		playerBaseHandSize: nonNegativeInt,
		gmHandFormula: gmHandFormulaParamsSchema,
		cardsPerInitiativeTurn: z.number().int().positive(),
		actionExcludesMinorAction: z.literal(true),
		gmPlayBudget: nonNegativeInt,
		gmDiscardsLimitedByHand: z.literal(true),
		fool: challengeFoolConfigSchema
	})
	.strict();

export type ChallengeConfigSchema = z.infer<typeof challengeConfigSchema>;

/**
 * Builds the validated `ChallengeConfig` from the content pack's `formulas`
 * catalog (`player-hand-size`, `gm-hand-size`) and the `challenge-round`
 * procedure's `params` block. Pure and read-only: it assembles and validates
 * the config shape and performs no game-rule calculation (hand-size math,
 * dealing, initiative) — that behavior belongs to later Challenge tasks.
 */
export function buildChallengeConfig(
	procedures: readonly TarotProcedureDefinition[],
	formulas: readonly TarotFormulaDefinition[]
): ChallengeConfig {
	const challengeRound = procedures.find((procedure) => procedure.id === 'challenge-round');
	if (!challengeRound) {
		throw new Error('content pack is missing the challenge-round procedure');
	}
	const params = challengeRoundParamsSchema.parse(challengeRound.params);

	const gmHandSizeFormula = formulas.find((formula) => formula.id === 'gm-hand-size');
	if (!gmHandSizeFormula) {
		throw new Error('content pack is missing the gm-hand-size formula');
	}
	const gmHandFormula = gmHandFormulaParamsSchema.parse(gmHandSizeFormula.params);

	const playerHandSizeFormula = formulas.find((formula) => formula.id === 'player-hand-size');
	if (!playerHandSizeFormula) {
		throw new Error('content pack is missing the player-hand-size formula');
	}
	const { base: playerBaseHandSize } = playerHandSizeParamsSchema.parse(
		playerHandSizeFormula.params
	);

	return challengeConfigSchema.parse({
		schemaVersion: 1,
		playerBaseHandSize,
		gmHandFormula,
		cardsPerInitiativeTurn: params.cardsPerInitiativeTurn,
		actionExcludesMinorAction: params.actionExcludesMinorAction,
		gmPlayBudget: params.gmPlayBudget,
		gmDiscardsLimitedByHand: params.gmDiscardsLimitedByHand,
		fool: params.fool
	});
}

// ---------------------------------------------------------------------------
// ChallengeStateV1
// ---------------------------------------------------------------------------

export const challengeStageSchema = z.enum([
	'setup',
	'deal',
	'initiative-placement',
	'initiative-reveal',
	'turns',
	'round-cleanup',
	'complete'
]);

/** Mirrors `ChallengeEnemyFact`. `count` is the entry's headcount (one
 * significant character or one group — see that type's doc comment) and
 * must be a positive integer; `count: 0` or negative is rejected. Exported
 * so `reducer.ts` can `safeParse` a GM-supplied `enemyFacts` array at the top
 * of `beginChallenge`/`cleanupRound`, before any state mutation, and reject
 * (rather than throw) a malformed entry (Increment 3 Task 2 review, Important
 * 2). */
export const challengeEnemyFactSchema = z
	.object({
		id: z.string().trim().min(1),
		size: z.string().trim().min(1),
		threat: z.string().trim().min(1),
		typeIds: z.array(z.string().trim().min(1)),
		count: z.number().int().positive()
	})
	.strict();

/** Mirrors `ChallengeStateV1.tenureOwners` — maps a tenure id to its owning
 * user id. Exported so `reducer.ts` can `safeParse` a GM-supplied mapping
 * before mutating state, mirroring `challengeEnemyFactSchema` (Increment 3
 * Task 2 tenureId-vs-userId fix: a tenure is never a user id and must not be
 * compared against one directly). */
export const challengeTenureOwnersSchema = z.record(z.string(), tenureId);

const challengeInitiativeEntrySchema = z
	.object({
		tenureId,
		cardZoneId: z.string().trim().min(1),
		revealed: z.boolean()
	})
	.strict();

const challengeParticipantBudgetSchema = z
	.object({
		cardsThisTurn: nonNegativeInt,
		actionTaken: z.boolean(),
		discards: nonNegativeInt.nullable()
	})
	.strict();

export const challengeModifierStateSchema = z
	.object({
		instanceId: z.string().trim().min(1),
		modifierId: z.string().trim().min(1),
		ownerTenureId: tenureId,
		targetTenureId: tenureId.optional(),
		status: z.enum(['pending', 'active', 'resolved', 'expired']),
		usesRemaining: nonNegativeInt.optional()
	})
	.strict();

/** Mirrors `ChallengeStateV1`. `.strict()` throughout so a malformed or
 * tampered state fails loudly rather than silently dropping fields. */
export const challengeStateV1Schema = z
	.object({
		schemaVersion: z.literal(1),
		stage: challengeStageSchema,
		round: z.number().int().positive(),
		participantTenureIds: z.array(tenureId),
		tenureOwners: challengeTenureOwnersSchema,
		pendingJoinTenureIds: z.array(tenureId),
		enemyFacts: z.array(challengeEnemyFactSchema),
		initiativeOrder: z.array(challengeInitiativeEntrySchema),
		tiedGroups: z.array(z.array(tenureId)),
		activeTurnIndex: z.number().int().nonnegative().nullable(),
		turnKind: z.enum(['normal', 'fool-extra']).nullable(),
		budgets: z.record(z.string(), challengeParticipantBudgetSchema),
		mulliganUsedThisRound: z.boolean(),
		modifiers: z.array(challengeModifierStateSchema)
	})
	.strict();

export type ChallengeStateV1Schema = z.infer<typeof challengeStateV1Schema>;

/** Parses `value` against `challengeStateV1Schema`, throwing a labeled error
 * on failure — mirrors `content-pack.schema.ts`'s `parseOrThrow`. */
export function parseChallengeStateOrThrow(value: unknown): ChallengeStateV1 {
	const result = challengeStateV1Schema.safeParse(value);
	if (!result.success) {
		throw new Error(`Invalid Challenge state: ${result.error.message}`);
	}
	return result.data;
}
