import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { denizens } from '$lib/server/db/schema';
import { ensureUser } from '$lib/server/auth';
import { eq, and } from 'drizzle-orm';
import {
	updateDenizenSchema,
	describeIssues,
	MAX_DENIZEN_PAYLOAD_BYTES
} from '$lib/schemas/denizen.schema';
import { validateSavedDenizen } from '$lib/server/validation/denizen';
import { sanitizeDraft } from '$lib/engine/denizen-builder';
import { privateHeaders, readBoundedJson } from '$lib/server/http';

const MAX_BODY_BYTES = MAX_DENIZEN_PAYLOAD_BYTES + 4096;

/** Ownership scope shared by every handler: this user's live (unarchived) row. */
const ownedLive = (id: string, userId: string) =>
	and(eq(denizens.id, id), eq(denizens.userId, userId), eq(denizens.isArchived, false));

/**
 * GET /api/denizens/:id — the stored draft, sanitized on read. Content-pack
 * ids can change out from under saved rows; the field-by-field sanitizer
 * repairs what it can, exactly like the builder's localStorage load.
 * Archived rows 404 here just as they do on the pages — one id, one answer.
 */
export const GET: RequestHandler = async (event) => {
	const db = await getDb(event);
	const userId = await ensureUser(event);

	const row = await db.select().from(denizens).where(ownedLive(event.params.id, userId)).get();

	if (!row) throw error(404, 'Denizen not found');

	let storedDraft: unknown;
	try {
		storedDraft = JSON.parse(row.data);
	} catch {
		storedDraft = null;
	}
	// Curated projection — internal columns (userId, isArchived) stay server-side.
	return json(
		{
			id: row.id,
			name: row.name,
			theme: row.theme,
			threat: row.threat,
			version: row.version,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			data: sanitizeDraft(storedDraft)
		},
		{ headers: privateHeaders() }
	);
};

/**
 * PUT /api/denizens/:id — update under an integer version claim, like
 * character writes: the UPDATE itself is conditional on
 * (id, userId, version), so a stale claim loses atomically and gets a 409 +
 * `{ currentVersion }` to refetch and retry with.
 */
export const PUT: RequestHandler = async (event) => {
	const db = await getDb(event);
	const userId = await ensureUser(event);

	const rawBody = await readBoundedJson(event, MAX_BODY_BYTES);
	const parsed = updateDenizenSchema.safeParse(rawBody);
	if (!parsed.success) {
		throw error(400, `Invalid denizen data: ${describeIssues(parsed.error.issues)}`);
	}
	const draft = sanitizeDraft(parsed.data.draft);

	const ruleCheck = validateSavedDenizen(draft);
	if (!ruleCheck.valid) {
		throw error(400, `Denizen is not saveable: ${ruleCheck.errors.join('; ')}`);
	}

	const { expectedVersion } = parsed.data;
	const updated = await db
		.update(denizens)
		.set({
			name: draft.name.trim() || 'Unnamed Denizen',
			theme: draft.themeId ?? '',
			threat: draft.threatId ?? '',
			data: JSON.stringify(draft),
			version: expectedVersion + 1,
			updatedAt: new Date()
		})
		.where(and(ownedLive(event.params.id, userId), eq(denizens.version, expectedVersion)))
		.returning({ version: denizens.version });

	if (updated.length === 1) {
		return json({ success: true, version: updated[0].version }, { headers: privateHeaders() });
	}

	// The conditional write lost — distinguish "gone" from "stale claim".
	const current = await db
		.select({ version: denizens.version })
		.from(denizens)
		.where(ownedLive(event.params.id, userId))
		.get();

	if (!current) throw error(404, 'Denizen not found');
	return json(
		{
			message: 'Denizen was updated elsewhere — refetch and retry',
			currentVersion: current.version
		},
		{ status: 409, headers: privateHeaders() }
	);
};

/** DELETE /api/denizens/:id — archive (soft delete), ownership in the write. */
export const DELETE: RequestHandler = async (event) => {
	const db = await getDb(event);
	const userId = await ensureUser(event);

	const archived = await db
		.update(denizens)
		.set({ isArchived: true, updatedAt: new Date() })
		.where(ownedLive(event.params.id, userId))
		.returning({ id: denizens.id });

	if (archived.length !== 1) throw error(404, 'Denizen not found');
	return json({ success: true }, { headers: privateHeaders() });
};
