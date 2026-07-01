import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { characters } from '$lib/server/db/schema';
import { and, eq } from 'drizzle-orm';
import { migrateCharacterData } from '$lib/engine/character-migration';
import { buildCharacterView } from '$lib/server/character/view';

/** Owner-only adventurer sheet with export + share actions. */
export const load: PageServerLoad = async (event) => {
	const session = await event.locals.auth();
	const userId = session?.user?.id;
	if (!userId) throw redirect(302, `/login?callbackUrl=/sheet/${event.params.id}`);

	const db = await getDb(event);
	const row = await db
		.select()
		.from(characters)
		.where(and(eq(characters.id, event.params.id), eq(characters.userId, userId)))
		.get();

	if (!row) throw error(404, 'Adventurer not found');

	const character = migrateCharacterData(JSON.parse(row.data));
	return {
		id: row.id,
		view: buildCharacterView(character),
		shareId: row.shareId,
		isDraft: row.isDraft
	};
};
