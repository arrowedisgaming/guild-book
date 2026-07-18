import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { denizens } from '$lib/server/db/schema';
import { ensureUser } from '$lib/server/auth';
import { eq, and } from 'drizzle-orm';
import { saveDenizenSchema } from '$lib/schemas/denizen.schema';
import { validateSavedDenizen } from '$lib/server/validation/denizen';
import { sanitizeDraft } from '$lib/engine/denizen-builder';

/**
 * GET /api/denizens/:id — the stored draft, sanitized on read. Content-pack
 * ids can change out from under saved rows; the field-by-field sanitizer
 * repairs what it can, exactly like the builder's localStorage load.
 */
export const GET: RequestHandler = async (event) => {
	const db = await getDb(event);
	const userId = await ensureUser(event);

	const row = await db
		.select()
		.from(denizens)
		.where(and(eq(denizens.id, event.params.id), eq(denizens.userId, userId)))
		.get();

	if (!row) throw error(404, 'Denizen not found');

	let storedDraft: unknown;
	try {
		storedDraft = JSON.parse(row.data);
	} catch {
		storedDraft = null;
	}
	return json({ ...row, data: sanitizeDraft(storedDraft) });
};

/**
 * PUT /api/denizens/:id — update. Same optional `expectedUpdatedAt`
 * precondition as the characters API: a stale write gets 409 +
 * `{ currentUpdatedAt }` so the client can refetch and retry.
 */
export const PUT: RequestHandler = async (event) => {
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
	const draft = sanitizeDraft(parsed.data.draft);

	const ruleCheck = validateSavedDenizen(draft);
	if (!ruleCheck.valid) {
		throw error(400, `Denizen is not saveable: ${ruleCheck.errors.join('; ')}`);
	}

	const existing = await db
		.select({ id: denizens.id, updatedAt: denizens.updatedAt })
		.from(denizens)
		.where(and(eq(denizens.id, event.params.id), eq(denizens.userId, userId)))
		.get();

	if (!existing) throw error(404, 'Denizen not found');

	const expectedUpdatedAt = parsed.data.expectedUpdatedAt;
	if (typeof expectedUpdatedAt === 'number' && existing.updatedAt.getTime() !== expectedUpdatedAt) {
		return json(
			{
				message: 'Denizen was updated elsewhere — refetch and retry',
				currentUpdatedAt: existing.updatedAt.getTime()
			},
			{ status: 409 }
		);
	}

	// Force a monotonically-advancing updatedAt (second precision) so the next
	// optimistic-concurrency comparison can detect this write.
	const now = new Date();
	const nextSec = Math.max(
		Math.floor(now.getTime() / 1000),
		Math.floor(existing.updatedAt.getTime() / 1000) + 1
	);
	const nextUpdatedAt = new Date(nextSec * 1000);

	await db
		.update(denizens)
		.set({
			name: draft.name.trim() || 'Unnamed Denizen',
			theme: draft.themeId ?? '',
			threat: draft.threatId ?? '',
			data: JSON.stringify(draft),
			updatedAt: nextUpdatedAt
		})
		.where(eq(denizens.id, event.params.id));

	return json({ success: true, updatedAt: nextUpdatedAt.getTime() });
};

/** DELETE /api/denizens/:id — archive (soft delete). */
export const DELETE: RequestHandler = async (event) => {
	const db = await getDb(event);
	const userId = await ensureUser(event);

	const existing = await db
		.select({ id: denizens.id })
		.from(denizens)
		.where(and(eq(denizens.id, event.params.id), eq(denizens.userId, userId)))
		.get();

	if (!existing) throw error(404, 'Denizen not found');

	await db
		.update(denizens)
		.set({ isArchived: true, updatedAt: new Date() })
		.where(eq(denizens.id, event.params.id));

	return json({ success: true });
};
