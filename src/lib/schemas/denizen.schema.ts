import { z } from 'zod';

/**
 * Zod validation for the saved-denizen payload. The blob is the DenizenDraft
 * only — the draft is authoritative and the definition re-materializes from
 * it on render, so stored rows can't drift stale against content-pack text.
 *
 * Shape-level checks live here (types, field caps, an overall payload size
 * cap); the stat/template invariants are enforced server-side by
 * validateSavedDenizen, which reuses the engine's draftStatWarnings so the
 * builder's live warnings and the API reject exactly the same drafts.
 */

/** Serialized-payload ceiling — far above any real draft, well below abuse. */
export const MAX_DENIZEN_PAYLOAD_BYTES = 64_000;

const abilitySchema = z.object({
	name: z.string().min(1).max(200),
	text: z.string().min(1).max(4000)
});

const statString = z.string().max(20);

const poolDraftSchema = z.object({
	name: z.string().max(200),
	health: statString,
	defense: statString,
	text: z.string().max(4000),
	notes: z.array(abilitySchema).max(50),
	lesserDooms: z.array(abilitySchema).max(50),
	greaterDooms: z.array(abilitySchema).max(50)
});

export const denizenDraftSchema = z.object({
	kind: z.enum(['creature', 'person']),
	name: z.string().max(200),
	concept: z.string().max(1000),
	exaggeration: z.string().max(1000),
	flavor: z.string().max(8000),
	themeId: z.string().max(100).nullable(),
	threatId: z.string().max(100).nullable(),
	kithId: z.string().max(100).nullable(),
	kinId: z.string().max(100).nullable(),
	seededFrom: z
		.object({ themeId: z.string().max(100), threatId: z.string().max(100) })
		.nullable(),
	attributes: z.object({
		swords: statString,
		pentacles: statString,
		cups: statString,
		wands: statString
	}),
	health: statString,
	defense: statString,
	healthBeforeWounds: statString,
	statNote: z.string().max(1000),
	likes: z.string().max(2000),
	hates: z.string().max(2000),
	notes: z.array(abilitySchema).max(50),
	lesserDooms: z.array(abilitySchema).max(50),
	greaterDooms: z.array(abilitySchema).max(50),
	pools: z.array(poolDraftSchema).max(20),
	specialRules: z.string().max(8000)
});

export const saveDenizenSchema = z
	.object({
		draft: denizenDraftSchema,
		/** Optimistic-concurrency precondition for PUT, as ms-since-epoch. */
		expectedUpdatedAt: z.number().optional()
	})
	.superRefine((payload, ctx) => {
		if (JSON.stringify(payload.draft).length > MAX_DENIZEN_PAYLOAD_BYTES) {
			ctx.addIssue({ code: 'custom', message: 'Denizen is too large to save' });
		}
	});
