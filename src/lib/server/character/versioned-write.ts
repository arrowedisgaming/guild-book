import { and, eq } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { AppDb } from '$lib/server/db';
import * as schema from '$lib/server/db/schema';
import { characters, characterVersionClaims } from '$lib/server/db/schema';
import type { GuildBookCharacterData } from '$lib/types/character';

export type CharacterWriteResult =
	| { ok: true; version: number; updatedAt: Date }
	| { ok: false; reason: 'not-found' }
	| { ok: false; reason: 'version-conflict'; currentVersion: number };

export interface WholeCharacterWrite {
	characterId: string;
	ownerUserId: string;
	actorUserId: string;
	expectedVersion: number;
	data: GuildBookCharacterData;
}

export interface CreateVersionedCharacter {
	characterId: string;
	ownerUserId: string;
	actorUserId: string;
	data: GuildBookCharacterData;
	createdAt: Date;
}

export interface CharacterMetadataWrite {
	characterId: string;
	ownerUserId: string;
	actorUserId: string;
	expectedVersion: number;
	now?: Date;
	mutation:
		| { kind: 'archive' }
		| { kind: 'share-enable'; shareId: string }
		| { kind: 'share-disable' };
}

type D1AppDb = DrizzleD1Database<typeof schema>;

/** Insert a new character and its mandatory version-1 claim atomically. */
export async function createCharacterWithVersionClaim(
	db: AppDb,
	write: CreateVersionedCharacter
): Promise<{ version: 1; updatedAt: Date }> {
	const characterInsert = {
		id: write.characterId,
		userId: write.ownerUserId,
		name: write.data.name || 'Unnamed Adventurer',
		kith: write.data.kithId ?? '',
		path: write.data.pathId ?? '',
		data: JSON.stringify(write.data),
		version: 1,
		lifeStatus: write.data.life.status,
		isDraft: write.data.isDraft,
		isArchived: false,
		createdAt: write.createdAt,
		updatedAt: write.createdAt
	};
	const claimInsert = {
		characterId: write.characterId,
		resultingVersion: 1,
		mutationKind: 'create',
		actorUserId: write.actorUserId,
		createdAt: write.createdAt
	};

	if (isD1Database(db)) {
		const d1 = db as unknown as D1AppDb;
		await d1.batch([
			d1.insert(characters).values(characterInsert),
			d1.insert(characterVersionClaims).values(claimInsert)
		]);
	} else {
		db.transaction((tx) => {
			tx.insert(characters).values(characterInsert).run();
			tx.insert(characterVersionClaims).values(claimInsert).run();
		});
	}

	return { version: 1, updatedAt: write.createdAt };
}

/**
 * Replace one owned character document under an integer version claim.
 * The claim and conditional update are one atomic unit on both supported
 * database targets, so a stale full-sheet save can never overwrite a winner.
 */
export async function saveWholeCharacter(
	db: AppDb,
	write: WholeCharacterWrite
): Promise<CharacterWriteResult> {
	const existing = await readOwnedVersion(db, write.characterId, write.ownerUserId);
	if (!existing) return { ok: false, reason: 'not-found' };
	if (existing.version !== write.expectedVersion) {
		return { ok: false, reason: 'version-conflict', currentVersion: existing.version };
	}

	const resultingVersion = write.expectedVersion + 1;
	const updatedAt = nextUpdatedAt(existing.updatedAt);
	const values = {
		name: write.data.name || 'Unnamed Adventurer',
		kith: write.data.kithId ?? '',
		path: write.data.pathId ?? '',
		data: JSON.stringify(write.data),
		lifeStatus: write.data.life.status,
		isDraft: write.data.isDraft,
		version: resultingVersion,
		updatedAt
	};

	try {
		if (isD1Database(db)) {
			const d1 = db as unknown as D1AppDb;
			await d1.batch([
				d1.insert(characterVersionClaims).values({
					characterId: write.characterId,
					resultingVersion,
					mutationKind: 'whole-save',
					actorUserId: write.actorUserId,
					createdAt: updatedAt
				}),
				d1
					.update(characters)
					.set(values)
					.where(
						and(
							eq(characters.id, write.characterId),
							eq(characters.userId, write.ownerUserId),
							eq(characters.version, write.expectedVersion)
						)
					)
			]);
		} else {
			db.transaction((tx) => {
				tx.insert(characterVersionClaims)
					.values({
						characterId: write.characterId,
						resultingVersion,
						mutationKind: 'whole-save',
						actorUserId: write.actorUserId,
						createdAt: updatedAt
					})
					.run();

				const result = tx
					.update(characters)
					.set(values)
					.where(
						and(
							eq(characters.id, write.characterId),
							eq(characters.userId, write.ownerUserId),
							eq(characters.version, write.expectedVersion)
						)
					)
					.run();

				if (result.changes !== 1) throw new Error('character version claim lost');
			});
		}
	} catch {
		return classifyFailedWrite(db, write.characterId, write.ownerUserId);
	}

	const saved = await readOwnedVersion(db, write.characterId, write.ownerUserId);
	if (!saved) return { ok: false, reason: 'not-found' };
	if (saved.version !== resultingVersion) {
		return { ok: false, reason: 'version-conflict', currentVersion: saved.version };
	}

	return { ok: true, version: saved.version, updatedAt: saved.updatedAt };
}

/** Apply a constrained non-document mutation under the same version ledger. */
export async function mutateCharacterMetadata(
	db: AppDb,
	write: CharacterMetadataWrite
): Promise<CharacterWriteResult> {
	const existing = await readOwnedVersion(db, write.characterId, write.ownerUserId);
	if (!existing) return { ok: false, reason: 'not-found' };
	if (existing.version !== write.expectedVersion) {
		return { ok: false, reason: 'version-conflict', currentVersion: existing.version };
	}

	const resultingVersion = write.expectedVersion + 1;
	const updatedAt = nextUpdatedAt(existing.updatedAt, write.now);
	const metadataValues =
		write.mutation.kind === 'archive'
			? { isArchived: true }
			: write.mutation.kind === 'share-enable'
				? { shareId: write.mutation.shareId, isPublic: true }
				: { shareId: null, isPublic: false };
	const values = { ...metadataValues, version: resultingVersion, updatedAt };

	try {
		if (isD1Database(db)) {
			const d1 = db as unknown as D1AppDb;
			await d1.batch([
				d1.insert(characterVersionClaims).values({
					characterId: write.characterId,
					resultingVersion,
					mutationKind: write.mutation.kind,
					actorUserId: write.actorUserId,
					createdAt: updatedAt
				}),
				d1
					.update(characters)
					.set(values)
					.where(
						and(
							eq(characters.id, write.characterId),
							eq(characters.userId, write.ownerUserId),
							eq(characters.version, write.expectedVersion)
						)
					)
			]);
		} else {
			db.transaction((tx) => {
				tx.insert(characterVersionClaims)
					.values({
						characterId: write.characterId,
						resultingVersion,
						mutationKind: write.mutation.kind,
						actorUserId: write.actorUserId,
						createdAt: updatedAt
					})
					.run();

				const result = tx
					.update(characters)
					.set(values)
					.where(
						and(
							eq(characters.id, write.characterId),
							eq(characters.userId, write.ownerUserId),
							eq(characters.version, write.expectedVersion)
						)
					)
					.run();

				if (result.changes !== 1) throw new Error('character version claim lost');
			});
		}
	} catch {
		return classifyFailedWrite(db, write.characterId, write.ownerUserId);
	}

	const saved = await readOwnedVersion(db, write.characterId, write.ownerUserId);
	if (!saved) return { ok: false, reason: 'not-found' };
	if (saved.version !== resultingVersion) {
		return { ok: false, reason: 'version-conflict', currentVersion: saved.version };
	}

	return { ok: true, version: saved.version, updatedAt: saved.updatedAt };
}

function isD1Database(db: AppDb): boolean {
	return typeof (db as unknown as { batch?: unknown }).batch === 'function';
}

async function readOwnedVersion(db: AppDb, characterId: string, ownerUserId: string) {
	return db
		.select({ version: characters.version, updatedAt: characters.updatedAt })
		.from(characters)
		.where(and(eq(characters.id, characterId), eq(characters.userId, ownerUserId)))
		.get();
}

async function classifyFailedWrite(
	db: AppDb,
	characterId: string,
	ownerUserId: string
): Promise<CharacterWriteResult> {
	const current = await readOwnedVersion(db, characterId, ownerUserId);
	if (!current) return { ok: false, reason: 'not-found' };
	return { ok: false, reason: 'version-conflict', currentVersion: current.version };
}

function nextUpdatedAt(previous: Date, now = new Date()): Date {
	const nextSecond = Math.max(
		Math.floor(now.getTime() / 1000),
		Math.floor(previous.getTime() / 1000) + 1
	);
	return new Date(nextSecond * 1000);
}
