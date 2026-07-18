import { z } from 'zod';
import { SUIT_IDS, ITEM_TIERS } from '$lib/types/common';

/**
 * Zod validation for the stored adventurer blob. The API validates against
 * this before persisting; the wizard produces it. Kept forgiving on
 * content-authored ids (plain strings) so future rulebook data validates
 * without schema churn.
 */

const allocationSourceSchema = z.object({
	source: z.enum(['kith', 'kin', 'path', 'personal', 'advancement']),
	sourceLabel: z.string(),
	at: z.string()
});

const attributeStateSchema = z.object({
	value: z.number(),
	sources: z.array(allocationSourceSchema)
});

const talentAllocationSchema = z.object({
	talentId: z.string(),
	state: z.enum(['mastered', 'in-training']),
	source: z.enum(['kin', 'path', 'arete', 'general']),
	sourceLabel: z.string(),
	at: z.string(),
	wounded: z.boolean(),
	xp: z.number()
});

const bondSchema = z.object({
	targetName: z.string(),
	text: z.string(),
	charged: z.boolean()
});

const equipmentEntrySchema = z.object({
	itemId: z.string().nullable(),
	customName: z.string().nullable(),
	tier: z.enum(ITEM_TIERS),
	packSpace: z.number(),
	location: z.enum(['hand', 'belt', 'pack', 'worn']),
	quantity: z.number(),
	notchesTaken: z.number()
});

const afflictionStateSchema = z.object({
	afflictionId: z.string().nullable(),
	customName: z.string().nullable(),
	stage: z.number()
});

const areteStateSchema = z.object({
	triggersMet: z.tuple([z.boolean(), z.boolean(), z.boolean()]),
	talentEarned: z.boolean()
});

const characterLifeSchema = z.discriminatedUnion('status', [
	z.object({ status: z.literal('alive') }),
	z.object({
		status: z.literal('dead'),
		diedAt: z.string().min(1),
		campaignId: z.string().min(1).optional(),
		sessionId: z.string().min(1).optional(),
		markedByUserId: z.string().min(1)
	})
]);

export const characterDataSchema = z.object({
	schemaVersion: z.number(),
	system: z.literal('hmtw'),
	contentPackId: z.string(),
	name: z.string(),
	pronouns: z.string(),
	appearance: z.string(),
	portraitUrl: z.string(),
	kithId: z.string().nullable(),
	kinId: z.string().nullable(),
	pathId: z.string().nullable(),
	attributes: z.record(z.enum(SUIT_IDS), attributeStateSchema),
	talents: z.array(talentAllocationSchema),
	quest: z.string(),
	motifs: z.array(z.string()),
	bonds: z.array(bondSchema),
	life: characterLifeSchema,
	resolve: z.object({ current: z.number(), max: z.number() }),
	arete: areteStateSchema,
	languages: z.array(z.string()),
	conditions: z.array(z.string()),
	afflictions: z.array(afflictionStateSchema),
	lore: z.number(),
	experience: z.number(),
	equipment: z.array(equipmentEntrySchema),
	notes: z.string(),
	isDraft: z.boolean(),
	wizardStep: z.number()
});

/** Request body for the create/update character API. */
export const createCharacterSchema = z.object({
	character: characterDataSchema
});

export type CharacterDataInput = z.infer<typeof characterDataSchema>;
