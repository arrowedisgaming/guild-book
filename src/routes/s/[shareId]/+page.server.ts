import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { loadSharedCharacter } from '$lib/server/character/share';
import { buildCharacterView } from '$lib/server/character/view';

/**
 * Anonymous, read-only view of a shared adventurer. No auth. Only the token in
 * the URL is used; owner-private fields (userId, share status) never leave the
 * server.
 */
export const load: PageServerLoad = async (event) => {
	const db = await getDb(event);
	const payload = await loadSharedCharacter(db, event.params.shareId);
	if (!payload) throw error(404, 'This shared adventurer does not exist or sharing was turned off.');

	return { view: buildCharacterView(payload.character) };
};
