import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { ensureUser } from '$lib/server/auth';
import { enableCharacterShare, disableCharacterShare } from '$lib/server/character/share';

/** POST /api/characters/:id/share — mint (or rotate) a public share token. */
export const POST: RequestHandler = async (event) => {
	const db = await getDb(event);
	const userId = await ensureUser(event);

	const result = await enableCharacterShare(db, { characterId: event.params.id, userId });
	if (!result.ok) throw error(result.status, result.message);

	const shareUrl = `${event.url.origin}/s/${result.shareId}`;
	return json({ shareId: result.shareId, shareUrl, version: result.version });
};

/** DELETE /api/characters/:id/share — revoke sharing. */
export const DELETE: RequestHandler = async (event) => {
	const db = await getDb(event);
	const userId = await ensureUser(event);

	const result = await disableCharacterShare(db, { characterId: event.params.id, userId });
	if (!result.ok) throw error(result.status, result.message);

	return json({ success: true, version: result.version });
};
