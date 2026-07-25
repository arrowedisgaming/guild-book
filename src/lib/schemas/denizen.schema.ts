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

/**
 * Per-user row ceiling, archived rows included (archive is soft, the rows
 * stay) — far above any real bestiary, low enough that one account cannot
 * grow the table without bound.
 */
export const MAX_DENIZENS_PER_USER = 200;

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
	// Shape bound only — generous enough that no legal draft can hit it even
	// if the pack grows (a fully-mastered person carries one note per talent);
	// the real ceiling is the byte cap below.
	notes: z.array(abilitySchema).max(200),
	lesserDooms: z.array(abilitySchema).max(50),
	greaterDooms: z.array(abilitySchema).max(50),
	pools: z.array(poolDraftSchema).max(20),
	specialRules: z.string().max(8000)
});

/** Readable issue list — keeps the path, so "which note?" has an answer. */
export const describeIssues = (
	issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>
): string =>
	issues
		.map((i) => (i.path.length ? `${i.path.map(String).join('.')}: ${i.message}` : i.message))
		.join(', ');

/** True bytes of the serialized draft — multi-byte text counts at full size. */
const draftWithinCap = (draft: unknown) =>
	new TextEncoder().encode(JSON.stringify(draft)).length <= MAX_DENIZEN_PAYLOAD_BYTES;

const capIssue = (ctx: z.RefinementCtx) =>
	ctx.addIssue({ code: 'custom', message: 'Denizen is too large to save' });

/** POST /api/denizens — create. */
export const saveDenizenSchema = z
	.object({ draft: denizenDraftSchema })
	.superRefine((payload, ctx) => {
		if (!draftWithinCap(payload.draft)) capIssue(ctx);
	});

/**
 * PUT /api/denizens/:id — update. `expectedVersion` is the integer version
 * claim (same discipline as character writes): the write only lands if the
 * row still carries this version, so a stale tab gets a 409 instead of
 * silently clobbering a newer save.
 */
export const updateDenizenSchema = z
	.object({
		draft: denizenDraftSchema,
		expectedVersion: z.number().int().min(1)
	})
	.superRefine((payload, ctx) => {
		if (!draftWithinCap(payload.draft)) capIssue(ctx);
	});
