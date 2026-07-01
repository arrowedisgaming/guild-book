import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { characters } from '$lib/server/db/schema';
import { ensureUser } from '$lib/server/auth';
import { eq, and } from 'drizzle-orm';
import type { GuildBookCharacterData } from '$lib/types/character';
import { createCharacterSchema } from '$lib/schemas/character.schema';
import { migrateCharacterData } from '$lib/engine/character-migration';
import { validateFinalCharacter } from '$lib/server/validation/character';

/** GET /api/characters/:id — full adventurer (migrated on read). */
export const GET: RequestHandler = async (event) => {
	const db = await getDb(event);
	const userId = await ensureUser(event);

	const row = await db
		.select()
		.from(characters)
		.where(and(eq(characters.id, event.params.id), eq(characters.userId, userId)))
		.get();

	if (!row) throw error(404, 'Adventurer not found');

	return json({ ...row, data: migrateCharacterData(JSON.parse(row.data)) });
};

/**
 * PUT /api/characters/:id — update.
 *
 * Optional `expectedUpdatedAt` precondition (ms-since-epoch): if supplied and
 * the row's `updatedAt` has moved since the client loaded it, the write is
 * rejected 409 + `{ currentUpdatedAt }` so the client can refetch and retry.
 * Callers that omit it (simple auto-save) are unaffected.
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
	const parsed = createCharacterSchema.safeParse(rawBody);
	if (!parsed.success) {
		throw error(400, `Invalid character data: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
	}
	const char = parsed.data.character as unknown as GuildBookCharacterData;

	const expectedUpdatedAt =
		rawBody && typeof rawBody === 'object' && 'expectedUpdatedAt' in rawBody
			? (rawBody as { expectedUpdatedAt?: unknown }).expectedUpdatedAt
			: undefined;

	if (!char.isDraft) {
		const ruleCheck = validateFinalCharacter(char);
		if (!ruleCheck.valid) {
			throw error(400, `Creation-rule violation: ${ruleCheck.errors.join('; ')}`);
		}
	}

	const existing = await db
		.select({ id: characters.id, updatedAt: characters.updatedAt })
		.from(characters)
		.where(and(eq(characters.id, event.params.id), eq(characters.userId, userId)))
		.get();

	if (!existing) throw error(404, 'Adventurer not found');

	if (typeof expectedUpdatedAt === 'number' && existing.updatedAt.getTime() !== expectedUpdatedAt) {
		return json(
			{
				message: 'Adventurer was updated elsewhere — refetch and retry',
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
		.update(characters)
		.set({
			name: char.name || 'Unnamed Adventurer',
			kith: char.kithId ?? '',
			path: char.pathId ?? '',
			data: JSON.stringify(char),
			isDraft: char.isDraft,
			updatedAt: nextUpdatedAt
		})
		.where(eq(characters.id, event.params.id));

	return json({ success: true, updatedAt: nextUpdatedAt.getTime() });
};

/** DELETE /api/characters/:id — archive (soft delete). */
export const DELETE: RequestHandler = async (event) => {
	const db = await getDb(event);
	const userId = await ensureUser(event);

	const existing = await db
		.select({ id: characters.id })
		.from(characters)
		.where(and(eq(characters.id, event.params.id), eq(characters.userId, userId)))
		.get();

	if (!existing) throw error(404, 'Adventurer not found');

	await db
		.update(characters)
		.set({ isArchived: true, updatedAt: new Date() })
		.where(eq(characters.id, event.params.id));

	return json({ success: true });
};
