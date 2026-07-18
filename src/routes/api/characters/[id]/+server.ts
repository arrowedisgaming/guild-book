import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { characters } from '$lib/server/db/schema';
import { ensureUser } from '$lib/server/auth';
import { eq, and } from 'drizzle-orm';
import type { GuildBookCharacterData } from '$lib/types/character';
import { updateCharacterSchema } from '$lib/schemas/character.schema';
import { migrateCharacterData } from '$lib/engine/character-migration';
import { validateFinalCharacter } from '$lib/server/validation/character';
import { mutateCharacterMetadata, saveWholeCharacter } from '$lib/server/character/versioned-write';

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
 * `expectedVersion` is the canonical optimistic-concurrency precondition.
 * `expectedUpdatedAt` remains as a one-release compatibility bridge for old
 * clients and is translated to the current integer version on an exact match.
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
	const parsed = updateCharacterSchema.safeParse(rawBody);
	if (!parsed.success) {
		throw error(400, `Invalid character data: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
	}
	const char = parsed.data.character as unknown as GuildBookCharacterData;

	if (!char.isDraft) {
		const ruleCheck = validateFinalCharacter(char);
		if (!ruleCheck.valid) {
			throw error(400, `Creation-rule violation: ${ruleCheck.errors.join('; ')}`);
		}
	}

	const existing = await db
		.select({ id: characters.id, version: characters.version, updatedAt: characters.updatedAt })
		.from(characters)
		.where(and(eq(characters.id, event.params.id), eq(characters.userId, userId)))
		.get();

	if (!existing) throw error(404, 'Adventurer not found');

	let expectedVersion = parsed.data.expectedVersion;
	if (
		expectedVersion === undefined &&
		existing.updatedAt.getTime() !== parsed.data.expectedUpdatedAt
	) {
		return json(
			{
				message: 'Adventurer was updated elsewhere — refetch and retry',
				currentVersion: existing.version
			},
			{ status: 409 }
		);
	}
	expectedVersion ??= existing.version;

	const result = await saveWholeCharacter(db, {
		characterId: event.params.id,
		ownerUserId: userId,
		actorUserId: userId,
		expectedVersion,
		data: char
	});
	if (!result.ok) {
		if (result.reason === 'not-found') throw error(404, 'Adventurer not found');
		return json(
			{
				message: 'Adventurer was updated elsewhere — refetch and retry',
				currentVersion: result.currentVersion
			},
			{ status: 409 }
		);
	}

	return json({ success: true, version: result.version, updatedAt: result.updatedAt.getTime() });
};

/** DELETE /api/characters/:id — archive (soft delete). */
export const DELETE: RequestHandler = async (event) => {
	const db = await getDb(event);
	const userId = await ensureUser(event);

	const existing = await db
		.select({ id: characters.id, version: characters.version })
		.from(characters)
		.where(and(eq(characters.id, event.params.id), eq(characters.userId, userId)))
		.get();

	if (!existing) throw error(404, 'Adventurer not found');

	const result = await mutateCharacterMetadata(db, {
		characterId: event.params.id,
		ownerUserId: userId,
		actorUserId: userId,
		expectedVersion: existing.version,
		mutation: { kind: 'archive' }
	});
	if (!result.ok) {
		if (result.reason === 'not-found') throw error(404, 'Adventurer not found');
		return json(
			{
				message: 'Adventurer was updated elsewhere — refetch and retry',
				currentVersion: result.currentVersion
			},
			{ status: 409 }
		);
	}

	return json({ success: true, version: result.version, updatedAt: result.updatedAt.getTime() });
};
