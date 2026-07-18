import { z } from 'zod';

const boundedText = (maximum: number) => z.string().trim().max(maximum);
const idSchema = z.string().trim().min(1).max(128);

export const guildRosterDocumentV1Schema = z.object({
	schemaVersion: z.literal(1),
	guildName: boundedText(100),
	sigilDescription: boundedText(1_000),
	terms: z.array(boundedText(500)).max(50),
	marchingOrder: z.array(idSchema).max(100),
	roles: z
		.array(
			z.object({
				id: idSchema,
				title: boundedText(100),
				membershipId: idSchema.nullable()
			})
		)
		.max(50),
	contracts: z
		.array(
			z.object({
				id: idSchema,
				title: boundedText(200),
				status: z.enum(['open', 'complete'])
			})
		)
		.max(100),
	deeds: z
		.array(
			z.object({
				id: idSchema,
				text: boundedText(1_000),
				occurredAt: z.iso.datetime({ offset: false, local: false }).max(64)
			})
		)
		.max(200),
	fame: z.number().int().nonnegative().max(1_000_000)
});

export const createCampaignSchema = z.object({
	name: z.string().trim().min(1).max(100),
	description: boundedText(2_000).default('')
});

export const updateCampaignSchema = z
	.object({
		expectedVersion: z.number().int().positive(),
		name: z.string().trim().min(1).max(100).optional(),
		description: boundedText(2_000).optional()
	})
	.refine((value) => value.name !== undefined || value.description !== undefined, {
		message: 'At least one campaign field is required'
	});

export const updateGuildRosterSchema = z.object({
	expectedVersion: z.number().int().positive(),
	document: guildRosterDocumentV1Schema
});
