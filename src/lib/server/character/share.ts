import { eq, and } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { characters } from '$lib/server/db/schema';
import type { AppDb } from '$lib/server/db';
import type { GuildBookCharacterData } from '$lib/types/character';
import { migrateCharacterData } from '$lib/engine/character-migration';
import { mutateCharacterMetadata } from './versioned-write';

/**
 * Token length for public share URLs. 16 chars from the nanoid alphabet gives
 * ~95 bits of entropy — unguessable in practice while keeping shared URLs
 * friendlier than the 21-char primary keys.
 */
export const SHARE_ID_LENGTH = 16;

export type EnableShareResult =
	| { ok: true; shareId: string; version: number }
	| { ok: false; status: 404 | 409; message: string };

/**
 * Enable sharing on a finished adventurer. Mints a fresh token (rotate
 * semantics — calling this on an already-shared character replaces the token,
 * invalidating the old URL). Drafts cannot be shared.
 */
export async function enableCharacterShare(
	db: AppDb,
	params: { characterId: string; userId: string },
	now: Date = new Date()
): Promise<EnableShareResult> {
	const existing = await db
		.select({ id: characters.id, isDraft: characters.isDraft, version: characters.version })
		.from(characters)
		.where(and(eq(characters.id, params.characterId), eq(characters.userId, params.userId)))
		.get();

	if (!existing) return { ok: false, status: 404, message: 'Adventurer not found' };
	if (existing.isDraft) {
		return { ok: false, status: 409, message: 'Drafts cannot be shared. Finish the adventurer first.' };
	}

	const shareId = nanoid(SHARE_ID_LENGTH);
	const mutation = await mutateCharacterMetadata(db, {
		characterId: params.characterId,
		ownerUserId: params.userId,
		actorUserId: params.userId,
		expectedVersion: existing.version,
		now,
		mutation: { kind: 'share-enable', shareId }
	});
	if (!mutation.ok) {
		if (mutation.reason === 'not-found') {
			return { ok: false, status: 404, message: 'Adventurer not found' };
		}
		return {
			ok: false,
			status: 409,
			message: 'Adventurer was updated elsewhere — refetch and retry'
		};
	}

	return { ok: true, shareId, version: mutation.version };
}

export type DisableShareResult =
	| { ok: true; version: number }
	| { ok: false; status: 404 | 409; message: string };

/**
 * Disable sharing. Clears the token so the public URL stops resolving
 * immediately. Idempotent — succeeds even if not currently shared.
 */
export async function disableCharacterShare(
	db: AppDb,
	params: { characterId: string; userId: string },
	now: Date = new Date()
): Promise<DisableShareResult> {
	const existing = await db
		.select({ id: characters.id, version: characters.version })
		.from(characters)
		.where(and(eq(characters.id, params.characterId), eq(characters.userId, params.userId)))
		.get();

	if (!existing) return { ok: false, status: 404, message: 'Adventurer not found' };

	const mutation = await mutateCharacterMetadata(db, {
		characterId: params.characterId,
		ownerUserId: params.userId,
		actorUserId: params.userId,
		expectedVersion: existing.version,
		now,
		mutation: { kind: 'share-disable' }
	});
	if (!mutation.ok) {
		if (mutation.reason === 'not-found') {
			return { ok: false, status: 404, message: 'Adventurer not found' };
		}
		return {
			ok: false,
			status: 409,
			message: 'Adventurer was updated elsewhere — refetch and retry'
		};
	}

	return { ok: true, version: mutation.version };
}

export type SharedCharacterPayload = {
	name: string;
	character: GuildBookCharacterData;
};

/**
 * Public lookup by share token. Returns the migrated character when it exists,
 * is currently shared, and is not archived. Never returns `userId` or other
 * owner-private fields — the token is the only identifier the visitor holds.
 */
export async function loadSharedCharacter(
	db: AppDb,
	shareId: string
): Promise<SharedCharacterPayload | null> {
	const row = await db
		.select({ name: characters.name, data: characters.data })
		.from(characters)
		.where(
			and(
				eq(characters.shareId, shareId),
				eq(characters.isPublic, true),
				eq(characters.isArchived, false)
			)
		)
		.get();

	if (!row) return null;

	const character = migrateCharacterData(JSON.parse(row.data));
	return { name: row.name, character };
}
