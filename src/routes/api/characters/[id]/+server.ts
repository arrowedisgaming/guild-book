import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { characters } from '$lib/server/db/schema';
import { ensureUser } from '$lib/server/auth';
import { eq, and } from 'drizzle-orm';
import { CHARACTER_SCHEMA_VERSION, type GuildBookCharacterData } from '$lib/types/character';
import { updateCharacterSchema } from '$lib/schemas/character.schema';
import { migrateCharacterData } from '$lib/engine/character-migration';
import { validateFinalCharacter, validateCharacterPlayState } from '$lib/server/validation/character';
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
	const supplied = (rawBody as { character?: { schemaVersion?: unknown } } | null)?.character;
	if (supplied && supplied.schemaVersion !== CHARACTER_SCHEMA_VERSION) {
		return json({ message: 'Character format has changed — reload the adventurer before saving.' }, { status: 409 });
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
		.select({ id: characters.id, version: characters.version, updatedAt: characters.updatedAt, data: characters.data })
		.from(characters)
		.where(and(eq(characters.id, event.params.id), eq(characters.userId, userId)))
		.get();

	if (!existing) throw error(404, 'Adventurer not found');

	// A stale write is a conflict, not a bad request: checked before the play
	// state is replayed against the newer stored copy, which would otherwise
	// report a 400 "history rewritten" the client can't recover from by retry.
	// The atomic version claim below still catches races after this point.
	let expectedVersion = parsed.data.expectedVersion;
	if (
		(expectedVersion !== undefined && expectedVersion !== existing.version) ||
		(expectedVersion === undefined && existing.updatedAt.getTime() !== parsed.data.expectedUpdatedAt)
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

	const playCheck = validateCharacterPlayState(char, migrateCharacterData(JSON.parse(existing.data)));
	if (!playCheck.valid) throw error(400, playCheck.errors.join('; '));

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
