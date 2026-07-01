import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { characters } from '$lib/server/db/schema';
import { ensureUser } from '$lib/server/auth';
import { eq, and, desc } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { createCharacterSchema } from '$lib/schemas/character.schema';
import { validateFinalCharacter } from '$lib/server/validation/character';
import type { GuildBookCharacterData } from '$lib/types/character';

/** GET /api/characters — list the signed-in user's adventurers. */
export const GET: RequestHandler = async (event) => {
	const db = await getDb(event);
	const userId = await ensureUser(event);

	const rows = await db
		.select({
			id: characters.id,
			name: characters.name,
			kith: characters.kith,
			path: characters.path,
			isDraft: characters.isDraft,
			shareId: characters.shareId,
			isPublic: characters.isPublic,
			createdAt: characters.createdAt,
			updatedAt: characters.updatedAt
		})
		.from(characters)
		.where(and(eq(characters.userId, userId), eq(characters.isArchived, false)))
		.orderBy(desc(characters.updatedAt));

	return json(rows);
};

/** POST /api/characters — create a new adventurer. */
export const POST: RequestHandler = async (event) => {
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

	if (!char.isDraft) {
		const ruleCheck = validateFinalCharacter(char);
		if (!ruleCheck.valid) {
			throw error(400, `Creation-rule violation: ${ruleCheck.errors.join('; ')}`);
		}
	}

	const id = nanoid();
	const now = new Date();

	await db.insert(characters).values({
		id,
		userId,
		name: char.name || 'Unnamed Adventurer',
		kith: char.kithId ?? '',
		path: char.pathId ?? '',
		data: JSON.stringify(char),
		isDraft: char.isDraft,
		isArchived: false,
		createdAt: now,
		updatedAt: now
	});

	return json({ id }, { status: 201 });
};
