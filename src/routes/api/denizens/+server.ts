import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { denizens } from '$lib/server/db/schema';
import { ensureUser } from '$lib/server/auth';
import { eq, and, desc } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { saveDenizenSchema } from '$lib/schemas/denizen.schema';
import { validateSavedDenizen } from '$lib/server/validation/denizen';
import { sanitizeDraft } from '$lib/engine/denizen-builder';

/** GET /api/denizens — list the signed-in user's denizens. */
export const GET: RequestHandler = async (event) => {
	const db = await getDb(event);
	const userId = await ensureUser(event);

	const rows = await db
		.select({
			id: denizens.id,
			name: denizens.name,
			theme: denizens.theme,
			threat: denizens.threat,
			createdAt: denizens.createdAt,
			updatedAt: denizens.updatedAt
		})
		.from(denizens)
		.where(and(eq(denizens.userId, userId), eq(denizens.isArchived, false)))
		.orderBy(desc(denizens.updatedAt));

	return json(rows);
};

/** POST /api/denizens — save a new denizen (the draft is the stored truth). */
export const POST: RequestHandler = async (event) => {
	const db = await getDb(event);
	const userId = await ensureUser(event);

	let rawBody: unknown;
	try {
		rawBody = await event.request.json();
	} catch {
		throw error(400, 'Request body is not valid JSON');
	}
	const parsed = saveDenizenSchema.safeParse(rawBody);
	if (!parsed.success) {
		throw error(400, `Invalid denizen data: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
	}
	// Normalize through the engine sanitizer so the stored draft is exactly
	// the shape the builder loads.
	const draft = sanitizeDraft(parsed.data.draft);

	const ruleCheck = validateSavedDenizen(draft);
	if (!ruleCheck.valid) {
		throw error(400, `Denizen is not saveable: ${ruleCheck.errors.join('; ')}`);
	}

	const id = nanoid();
	const now = new Date();

	await db.insert(denizens).values({
		id,
		userId,
		name: draft.name.trim() || 'Unnamed Denizen',
		theme: draft.themeId ?? '',
		threat: draft.threatId ?? '',
		data: JSON.stringify(draft),
		isArchived: false,
		createdAt: now,
		updatedAt: now
	});

	return json({ id }, { status: 201 });
};
