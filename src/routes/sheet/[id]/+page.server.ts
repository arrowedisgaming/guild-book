import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { characters } from '$lib/server/db/schema';
import { and, eq } from 'drizzle-orm';
import { migrateCharacterData } from '$lib/engine/character-migration';
import { buildCharacterView } from '$lib/server/character/view';
import { getUserId } from '$lib/server/auth';
import {
	getContentPack,
	getTalents,
	getItems,
	getConditions,
	getAfflictions
} from '$lib/server/content/loader';

/** Owner-only adventurer sheet with editing, play tracking, and exports. */
export const load: PageServerLoad = async (event) => {
	const userId = await getUserId(event);
	if (!userId) throw redirect(302, `/login?callbackUrl=/sheet/${event.params.id}`);

	const db = await getDb(event);
	const row = await db
		.select()
		.from(characters)
		.where(and(eq(characters.id, event.params.id), eq(characters.userId, userId)))
		.get();

	if (!row) throw error(404, 'Adventurer not found');

	const character = migrateCharacterData(JSON.parse(row.data));
	const pack = getContentPack();

	return {
		id: row.id,
		view: buildCharacterView(character),
		character,
		updatedAt: row.updatedAt.getTime(),
		shareId: row.shareId,
		isDraft: row.isDraft,
		// Content the client-side editors need to render pickers and names.
		content: {
			talents: getTalents(),
			items: getItems(),
			conditions: getConditions(),
			afflictions: getAfflictions(),
			encumbrance: pack.encumbrance,
			motifCount: pack.creation.motifCount,
			resolveMax: pack.creation.startingResolve
		}
	};
};
