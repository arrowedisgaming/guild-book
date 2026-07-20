import { describe, expect, it } from 'vitest';
import { getTarotProcedures } from '$lib/server/content/loader';
import {
	buildChallengeConfig,
	challengeConfigSchema,
	challengeStateV1Schema,
	parseChallengeStateOrThrow
} from '$lib/engine/session/procedures/challenge/schema';
import type { ChallengeStateV1 } from '$lib/engine/session/procedures/challenge/types';

/**
 * Increment 3 Task 1 — Challenge runtime content and state. Amendment 2 /
 * binding override O1: modifier ids are namespaced by procedure and
 * `challenge-round.modifierIds` stays `[]` (each modifier is its own
 * self-referencing procedure), so completeness is asserted against the
 * derived modifier set, not `challenge-round.modifierIds`.
 */
describe('Challenge content completeness', () => {
	it('the challenge-round procedure exists', () => {
		const challenge = getTarotProcedures().procedures.find((p) => p.id === 'challenge-round');
		expect(challenge).toBeDefined();
	});

	it('every Challenge modifier is present in the content pack, namespaced', () => {
		const mods = getTarotProcedures()
			.modifiers.filter((m) => m.phase === 'challenge')
			.map((m) => m.id);
		expect(mods).toEqual(
			expect.arrayContaining([
				'challenge-black-honey',
				'challenge-stun',
				'challenge-brainfever',
				'challenge-counsel',
				'challenge-guardian-angel',
				'challenge-aim',
				'challenge-guard'
			])
		);
	});
});

describe('ChallengeConfig hydration (O2/O3/O4/O5/O6)', () => {
	it('builds a validated config from the content pack formulas and challenge-round params', () => {
		const { procedures, formulas } = getTarotProcedures();
		const config = buildChallengeConfig(procedures, formulas);

		expect(config).toEqual({
			schemaVersion: 1,
			playerBaseHandSize: 4,
			gmHandFormula: {
				base: 3,
				perEnemyType: 1,
				enemiesOutnumberAdventurers: 1,
				enemiesDoubleAdventurers: 1,
				perLargerThanHumanEnemy: 1,
				eliteEnemyPresent: 2,
				dungeonLordPresent: 3
			},
			cardsPerInitiativeTurn: 1,
			actionExcludesMinorAction: true,
			gmPlayBudget: 1,
			gmDiscardsLimitedByHand: true,
			fool: {
				pairedPlayRequired: true,
				grantsExtraTurn: true,
				extraTurnMinorActions: 0,
				reshuffleBoundary: 'end-round'
			}
		});
	});

	it('never carries a Doom-tier boundary or a fabricated mulligan threshold (O2/O4)', () => {
		const { procedures, formulas } = getTarotProcedures();
		const config = buildChallengeConfig(procedures, formulas);

		expect(config).not.toHaveProperty('lesserDoomMax');
		expect(config).not.toHaveProperty('greaterDoomMin');
		expect(config).not.toHaveProperty('gmMulliganGreaterDoomThreshold');
	});

	it('rejects a negative gmPlayBudget', () => {
		const invalid = {
			schemaVersion: 1,
			playerBaseHandSize: 4,
			gmHandFormula: {
				base: 3,
				perEnemyType: 1,
				enemiesOutnumberAdventurers: 1,
				enemiesDoubleAdventurers: 1,
				perLargerThanHumanEnemy: 1,
				eliteEnemyPresent: 2,
				dungeonLordPresent: 3
			},
			cardsPerInitiativeTurn: 1,
			actionExcludesMinorAction: true,
			gmPlayBudget: -1,
			gmDiscardsLimitedByHand: true,
			fool: {
				pairedPlayRequired: true,
				grantsExtraTurn: true,
				extraTurnMinorActions: 0,
				reshuffleBoundary: 'end-round'
			}
		};

		expect(challengeConfigSchema.safeParse(invalid).success).toBe(false);
	});

	it('rejects a negative count inside gmHandFormula', () => {
		const invalid = {
			schemaVersion: 1,
			playerBaseHandSize: 4,
			gmHandFormula: {
				base: -3,
				perEnemyType: 1,
				enemiesOutnumberAdventurers: 1,
				enemiesDoubleAdventurers: 1,
				perLargerThanHumanEnemy: 1,
				eliteEnemyPresent: 2,
				dungeonLordPresent: 3
			},
			cardsPerInitiativeTurn: 1,
			actionExcludesMinorAction: true,
			gmPlayBudget: 1,
			gmDiscardsLimitedByHand: true,
			fool: {
				pairedPlayRequired: true,
				grantsExtraTurn: true,
				extraTurnMinorActions: 0,
				reshuffleBoundary: 'end-round'
			}
		};

		expect(challengeConfigSchema.safeParse(invalid).success).toBe(false);
	});
});

describe('ChallengeStateV1 schema (Step 3 + O4/O5)', () => {
	const validState: ChallengeStateV1 = {
		schemaVersion: 1,
		stage: 'turns',
		round: 1,
		participantTenureIds: ['tenure-1', 'tenure-2'],
		pendingJoinTenureIds: [],
		enemyFacts: [{ id: 'enemy-1', size: 'human', threat: 'minion', typeIds: ['goblin'], count: 1 }],
		initiativeOrder: [{ tenureId: 'tenure-1', cardZoneId: 'zone-1', revealed: true }],
		activeTurnIndex: 0,
		turnKind: 'normal',
		budgets: {
			'tenure-1': { cardsThisTurn: 0, actionTaken: false, discards: null },
			gm: { cardsThisTurn: 0, actionTaken: false, discards: 0 }
		},
		mulliganUsedThisRound: false,
		modifiers: []
	};

	it('accepts a well-formed state', () => {
		expect(() => parseChallengeStateOrThrow(validState)).not.toThrow();
	});

	it('carries mulliganUsedThisRound as a boolean flag, not a numeric threshold (O4)', () => {
		const parsed = parseChallengeStateOrThrow(validState);
		expect(typeof parsed.mulliganUsedThisRound).toBe('boolean');
	});

	it('uses a single cardsThisTurn/actionTaken budget pair, not separate play/minor-action counters (O5)', () => {
		expect(validState.budgets['tenure-1']).not.toHaveProperty('plays');
		expect(validState.budgets['tenure-1']).not.toHaveProperty('minorActions');
		expect(validState.budgets['tenure-1']).toHaveProperty('cardsThisTurn');
		expect(validState.budgets['tenure-1']).toHaveProperty('actionTaken');
	});

	it('rejects a negative cardsThisTurn count', () => {
		const invalid = {
			...validState,
			budgets: { 'tenure-1': { cardsThisTurn: -1, actionTaken: false, discards: null } }
		};
		expect(challengeStateV1Schema.safeParse(invalid).success).toBe(false);
	});

	it('rejects an unknown stage', () => {
		const invalid = { ...validState, stage: 'not-a-real-stage' };
		expect(challengeStateV1Schema.safeParse(invalid).success).toBe(false);
	});

	it('rejects an enemy fact with count < 1 (Increment 3 Task 2 coordinator follow-up)', () => {
		const zero = {
			...validState,
			enemyFacts: [{ id: 'enemy-1', size: 'human', threat: 'minion', typeIds: ['goblin'], count: 0 }]
		};
		expect(challengeStateV1Schema.safeParse(zero).success).toBe(false);

		const negative = {
			...validState,
			enemyFacts: [{ id: 'enemy-1', size: 'human', threat: 'minion', typeIds: ['goblin'], count: -1 }]
		};
		expect(challengeStateV1Schema.safeParse(negative).success).toBe(false);
	});
});
