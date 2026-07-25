import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { requireCampaignAccess } from '$lib/server/campaign/access';
import { getDb } from '$lib/server/db';
import { listCompletedSessions } from '$lib/server/session/history';

/**
 * Completed sessions list (Increment 4 Task 5 Step 3). GM and current members
 * only — `listCompletedSessions` returns `null` for anyone else, rendered as
 * the same 404 a nonexistent campaign gets. History responses are `private, no-store` —
 * installed by `requireCampaignAccess` on every campaign route.
 */
export const load: PageServerLoad = async (event) => {
	const role = await requireCampaignAccess(event, event.params.id);
	const db = await getDb(event);

	const sessions = await listCompletedSessions(db, event.params.id, role.userId);
	if (sessions === null) throw error(404, 'Campaign not found');

	return {
		campaignId: event.params.id,
		sessions: sessions.map((session) => ({ ...session, endedAt: session.endedAt.toISOString() }))
	};
};
