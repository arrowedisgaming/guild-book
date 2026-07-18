import { z } from 'zod';

/**
 * Zod validation for shared-tarot-table session state and commands. Mirrors
 * `src/lib/types/session.ts` — keep the two in lockstep. Command schemas are
 * `.strict()` so an attacker cannot smuggle e.g. `cardId` into a `draw`
 * command; the envelope schema is `.strict()` too so canonical request
 * hashing never sees unknown data silently stripped.
 */

const cardId = z.string().trim().min(1).max(128);
const userId = z.string().trim().min(1).max(128);
const zoneId = z.string().trim().min(1).max(128);

export const sessionPhaseSchema = z.enum(['crawl', 'challenge', 'camp', 'city']);
export const sessionStatusSchema = z.enum(['active', 'frozen', 'ended']);

export const ownedPrivateZoneSchema = z.object({
	id: zoneId,
	kind: z.enum(['player-hand', 'player-facedown', 'player-prepared']),
	ownerUserId: userId,
	cards: z.array(cardId)
});

export const publicZoneSchema = z.object({
	id: zoneId,
	kind: z.enum(['initiative', 'played', 'revealed', 'inspiration']),
	cards: z.array(cardId)
});

export const pendingZoneSchema = z.object({
	id: zoneId,
	deck: z.enum(['major', 'player']),
	cards: z.array(cardId)
});

export const procedureStateSchema = z
	.object({
		procedureId: z.string().trim().min(1).max(128),
		stepIndex: z.number().int().nonnegative(),
		pendingZoneIds: z.array(zoneId),
		gmPrivate: z.unknown().optional()
	})
	.nullable();

export const sessionEngineStateV1Schema = z.object({
	schemaVersion: z.literal(1),
	sessionId: z.string().trim().min(1).max(128),
	version: z.number().int().nonnegative(),
	phase: sessionPhaseSchema,
	procedure: procedureStateSchema,
	majorDraw: z.array(cardId),
	majorDiscard: z.array(cardId),
	playerDraw: z.array(cardId),
	playerDiscard: z.array(cardId),
	gmHand: z.array(cardId),
	privateZones: z.array(ownedPrivateZoneSchema),
	publicZones: z.array(publicZoneSchema),
	pendingZones: z.array(pendingZoneSchema),
	reshuffleAtBoundary: z.object({ major: z.boolean(), player: z.boolean() })
});

// ---------------------------------------------------------------------------
// Commands — each variant is `.strict()`.
// ---------------------------------------------------------------------------

const drawCommandSchema = z
	.object({
		type: z.literal('draw'),
		deck: z.enum(['major', 'player']),
		destinationZoneId: zoneId,
		count: z.number().int().positive().max(78)
	})
	.strict();

const dealCommandSchema = z
	.object({
		type: z.literal('deal'),
		deck: z.enum(['major', 'player']),
		destinationZoneIds: z.array(zoneId).min(1).max(20),
		countPerDestination: z.number().int().positive().max(78)
	})
	.strict();

const playCommandSchema = z
	.object({
		type: z.literal('play'),
		sourceZoneId: zoneId,
		cardId,
		destinationZoneId: zoneId
	})
	.strict();

const placeFacedownCommandSchema = z
	.object({
		type: z.literal('place-facedown'),
		sourceZoneId: zoneId,
		cardId,
		destinationZoneId: zoneId
	})
	.strict();

const revealCommandSchema = z
	.object({
		type: z.literal('reveal'),
		zoneId,
		cardId
	})
	.strict();

const discardCommandSchema = z
	.object({
		type: z.literal('discard'),
		sourceZoneId: zoneId,
		cardId,
		destinationZoneId: zoneId
	})
	.strict();

const transferCommandSchema = z
	.object({
		type: z.literal('transfer'),
		sourceZoneId: zoneId,
		cardId,
		destinationZoneId: zoneId
	})
	.strict();

const selectFromDiscardCommandSchema = z
	.object({
		type: z.literal('select-from-discard'),
		sourceZoneId: zoneId,
		cardId,
		destinationZoneId: zoneId
	})
	.strict();

const reorderTopCommandSchema = z
	.object({
		type: z.literal('reorder-top'),
		zoneId,
		cardIds: z.array(cardId).min(1).max(78)
	})
	.strict();

const mulliganCommandSchema = z
	.object({
		type: z.literal('mulligan'),
		zoneId
	})
	.strict();

const beginProcedureCommandSchema = z
	.object({
		type: z.literal('begin-procedure'),
		procedureId: z.string().trim().min(1).max(128)
	})
	.strict();

const advanceProcedureCommandSchema = z
	.object({
		type: z.literal('advance-procedure'),
		procedureId: z.string().trim().min(1).max(128)
	})
	.strict();

const completeProcedureCommandSchema = z
	.object({
		type: z.literal('complete-procedure'),
		procedureId: z.string().trim().min(1).max(128)
	})
	.strict();

const endRoundCommandSchema = z
	.object({
		type: z.literal('end-round')
	})
	.strict();

const applyCorrectionCommandSchema = z
	.object({
		type: z.literal('apply-correction'),
		targetEventId: z.string().trim().min(1).max(128),
		note: z.string().trim().max(1_000)
	})
	.strict();

export const sessionCommandSchema = z.discriminatedUnion('type', [
	drawCommandSchema,
	dealCommandSchema,
	playCommandSchema,
	placeFacedownCommandSchema,
	revealCommandSchema,
	discardCommandSchema,
	transferCommandSchema,
	selectFromDiscardCommandSchema,
	reorderTopCommandSchema,
	mulliganCommandSchema,
	beginProcedureCommandSchema,
	advanceProcedureCommandSchema,
	completeProcedureCommandSchema,
	endRoundCommandSchema,
	applyCorrectionCommandSchema
]);

export const sessionCommandEnvelopeSchema = z
	.object({
		commandId: z.string().trim().min(1).max(128),
		observedSessionVersion: z.number().int().nonnegative(),
		expectedStructuralVersion: z.number().int().nonnegative().optional(),
		observedCharacterVersion: z.number().int().nonnegative().optional(),
		command: sessionCommandSchema
	})
	.strict();
