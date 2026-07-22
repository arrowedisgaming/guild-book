import { z } from 'zod';
import { SUIT_IDS } from '$lib/types/common';
import { challengeEnemyFactSchema, challengeTenureOwnersSchema } from '$lib/engine/session/procedures/challenge/schema';

/**
 * Zod validation for the Challenge command surface (Increment 3 Task 6) —
 * `command.ts`'s `ChallengeCommand`. Mirrors `$lib/schemas/session.schema.ts`'s
 * own discipline exactly: every variant is `.strict()` (an attacker cannot
 * smuggle an extra field past canonical request hashing), and the envelope
 * reuses the SAME generic `{commandId, observedSessionVersion, command}`
 * shape as `SessionCommandEnvelope<C>` — this is a NEW, parallel command
 * surface, never a change to the frozen `sessionCommandEnvelopeSchema`/
 * `SessionCommand` union.
 */

const cardId = z.string().trim().min(1).max(128);
const tenureId = z.string().trim().min(1).max(128);
const suitId = z.enum(SUIT_IDS);

const cleanupRoundOptionsSchema = z
	.object({
		enemyFacts: z.array(challengeEnemyFactSchema).optional(),
		tenureOwners: challengeTenureOwnersSchema.optional()
	})
	.strict();

const beginChallengeCommandSchema = z
	.object({
		type: z.literal('begin-challenge'),
		participantTenureIds: z.array(tenureId).min(1).max(20),
		enemyFacts: z.array(challengeEnemyFactSchema).max(50),
		tenureOwners: challengeTenureOwnersSchema
	})
	.strict();

const dealRoundCommandSchema = z.object({ type: z.literal('deal-round') }).strict();

const placeInitiativeCommandSchema = z.object({ type: z.literal('place-initiative'), tenureId, cardId }).strict();

const placeGmInitiativeCommandSchema = z
	.object({ type: z.literal('place-gm-initiative'), enemyFactId: z.string().trim().min(1).max(128), cardId })
	.strict();

const revealInitiativeCommandSchema = z.object({ type: z.literal('reveal-initiative') }).strict();
const beginTurnsCommandSchema = z.object({ type: z.literal('begin-turns') }).strict();
const endTurnCommandSchema = z.object({ type: z.literal('end-turn') }).strict();

const playActionCommandSchema = z.object({ type: z.literal('play-action'), tenureId, cardId }).strict();
const playMinorActionCommandSchema = z.object({ type: z.literal('play-minor-action'), tenureId, cardId, actionSuit: suitId }).strict();
const playFoolCommandSchema = z.object({ type: z.literal('play-fool'), tenureId, pairedCardId: cardId }).strict();

const gmPlayCommandSchema = z.object({ type: z.literal('gm-play'), cardId }).strict();
const gmMinorActionCommandSchema = z.object({ type: z.literal('gm-minor-action'), cardId }).strict();
const gmDiscardCommandSchema = z.object({ type: z.literal('gm-discard'), cardId }).strict();
const gmMulliganCommandSchema = z.object({ type: z.literal('gm-mulligan') }).strict();

const cleanupRoundCommandSchema = z
	.object({ type: z.literal('cleanup-round'), options: cleanupRoundOptionsSchema.optional() })
	.strict();

const applyBlackHoneyCommandSchema = z.object({ type: z.literal('apply-black-honey'), targetTenureId: tenureId }).strict();
const applyStunCommandSchema = z.object({ type: z.literal('apply-stun'), targetTenureId: tenureId, cardId: cardId.optional() }).strict();
const applyBrainfeverCommandSchema = z.object({ type: z.literal('apply-brainfever'), targetTenureId: tenureId }).strict();
const counselTransferCommandSchema = z
	.object({ type: z.literal('counsel-transfer'), recipientUserId: z.string().trim().min(1).max(128), cardId })
	.strict();
const guardianAngelCommandSchema = z.object({ type: z.literal('guardian-angel'), targetTenureId: tenureId, cardId }).strict();
const resolveGuardianAngelCommandSchema = z
	.object({ type: z.literal('resolve-guardian-angel'), cardId, chosenAction: z.enum(['dodge', 'riposte']) })
	.strict();
const aimPrepareCommandSchema = z.object({ type: z.literal('aim-prepare'), cardId }).strict();
const resolveAimCommandSchema = z.object({ type: z.literal('resolve-aim'), cardId }).strict();
const replaceInitiativeWithShieldCommandSchema = z
	.object({ type: z.literal('replace-initiative-with-shield'), cardId })
	.strict();

export const challengeCommandSchema = z.discriminatedUnion('type', [
	beginChallengeCommandSchema,
	dealRoundCommandSchema,
	placeInitiativeCommandSchema,
	placeGmInitiativeCommandSchema,
	revealInitiativeCommandSchema,
	beginTurnsCommandSchema,
	endTurnCommandSchema,
	playActionCommandSchema,
	playMinorActionCommandSchema,
	playFoolCommandSchema,
	gmPlayCommandSchema,
	gmMinorActionCommandSchema,
	gmDiscardCommandSchema,
	gmMulliganCommandSchema,
	cleanupRoundCommandSchema,
	applyBlackHoneyCommandSchema,
	applyStunCommandSchema,
	applyBrainfeverCommandSchema,
	counselTransferCommandSchema,
	guardianAngelCommandSchema,
	resolveGuardianAngelCommandSchema,
	aimPrepareCommandSchema,
	resolveAimCommandSchema,
	replaceInitiativeWithShieldCommandSchema
]);

/** Same three-field shape as `SessionCommandEnvelope<C>` (`$lib/types/
 * session.ts`) — no `expectedStructuralVersion`/`observedCharacterVersion`:
 * every Challenge command is treated as non-structural (retried on a commit
 * race, never hard-gated on a client-supplied structural precondition) —
 * see `challenge-command-service.ts`'s file header for why. */
export const challengeCommandEnvelopeSchema = z
	.object({
		commandId: z.string().trim().min(1).max(128),
		observedSessionVersion: z.number().int().nonnegative(),
		command: challengeCommandSchema
	})
	.strict();
