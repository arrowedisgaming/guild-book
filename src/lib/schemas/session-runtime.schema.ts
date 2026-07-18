import { z } from 'zod';
import { SUIT_IDS, RANK_IDS } from '$lib/types/common';
import {
	tarotConfigSchema,
	tarotProcedureDefinitionSchema,
	sessionModifierDefinitionSchema,
	parseOrThrow
} from '$lib/schemas/content-pack.schema';

/**
 * Zod mirror of `SessionRuntimeContentV1` (`$lib/types/session.ts`) — the
 * compiled, immutable session runtime document Task 4 pins at session start.
 * Reuses the content-pack's own `tarotConfigSchema` /
 * `tarotProcedureDefinitionSchema` / `sessionModifierDefinitionSchema` rather
 * than redefining them, so the two stay in lockstep.
 */

const suitEnum = z.enum(SUIT_IDS);
const rankEnum = z.enum(RANK_IDS);
const doomTierEnum = z.enum(['lesser', 'greater']);
const valueParityEnum = z.enum(['odd', 'even']);

export const tarotCardCatalogEntrySchema = z
	.object({
		id: z.string(),
		deck: z.enum(['major', 'player']),
		label: z.string().optional(),
		imageKey: z.string().optional(),
		value: z.number().optional(),
		suit: suitEnum.optional(),
		rank: rankEnum.optional(),
		major: z
			.object({
				number: z.number(),
				name: z.string(),
				doomTier: doomTierEnum.optional(),
				valueParity: valueParityEnum
			})
			.optional()
	})
	.strict();

export const sessionRuntimeContentV1Schema = z
	.object({
		schemaVersion: z.literal(1),
		contentPackId: z.string(),
		contentPackVersion: z.string(),
		contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
		tarot: tarotConfigSchema,
		procedures: z.array(tarotProcedureDefinitionSchema),
		cards: z.array(tarotCardCatalogEntrySchema),
		modifiers: z.array(sessionModifierDefinitionSchema)
	})
	.strict();

export type SessionRuntimeContentV1Schema = z.infer<typeof sessionRuntimeContentV1Schema>;

/** Parses `value` against `sessionRuntimeContentV1Schema`, throwing a labeled
 * error on failure. Reuses `content-pack.schema.ts`'s generic `parseOrThrow`
 * rather than duplicating the fail-fast wrapper. */
export function parseSessionRuntimeContentOrThrow(value: unknown): SessionRuntimeContentV1Schema {
	return parseOrThrow(sessionRuntimeContentV1Schema, value, 'session runtime content');
}
