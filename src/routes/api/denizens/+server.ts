import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { denizens } from '$lib/server/db/schema';
import { ensureUser } from '$lib/server/auth';
import { eq, and, desc, count } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import {
	saveDenizenSchema,
	describeIssues,
	MAX_DENIZEN_PAYLOAD_BYTES,
	MAX_DENIZENS_PER_USER
} from '$lib/schemas/denizen.schema';
import { validateSavedDenizen } from '$lib/server/validation/denizen';
import { sanitizeDraft } from '$lib/engine/denizen-builder';
import { privateHeaders, readBoundedJson } from '$lib/server/http';

/** Envelope slack on top of the draft cap ({"draft":…} plus a version claim). */
const MAX_BODY_BYTES = MAX_DENIZEN_PAYLOAD_BYTES + 4096;

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

	return json(rows, { headers: privateHeaders() });
};

/** POST /api/denizens — save a new denizen (the draft is the stored truth). */
export const POST: RequestHandler = async (event) => {
	const db = await getDb(event);
	const userId = await ensureUser(event);

	const rawBody = await readBoundedJson(event, MAX_BODY_BYTES);
	const parsed = saveDenizenSchema.safeParse(rawBody);
	if (!parsed.success) {
		throw error(400, `Invalid denizen data: ${describeIssues(parsed.error.issues)}`);
	}
	// Normalize through the engine sanitizer so the stored draft is exactly
	// the shape the builder loads.
	const draft = sanitizeDraft(parsed.data.draft);

	const ruleCheck = validateSavedDenizen(draft);
	if (!ruleCheck.valid) {
		throw error(400, `Denizen is not saveable: ${ruleCheck.errors.join('; ')}`);
	}

	const owned = await db
		.select({ n: count() })
		.from(denizens)
		.where(eq(denizens.userId, userId))
		.get();
	if ((owned?.n ?? 0) >= MAX_DENIZENS_PER_USER) {
		throw error(400, `You have reached the limit of ${MAX_DENIZENS_PER_USER} saved denizens.`);
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
		version: 1,
		isArchived: false,
		createdAt: now,
		updatedAt: now
	});

	return json({ id, version: 1 }, { status: 201, headers: privateHeaders() });
};
