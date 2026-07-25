import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { requireCampaignAccess } from '$lib/server/campaign/access';
import { getDb } from '$lib/server/db';
import { loadCompletedSessionHistory } from '$lib/server/session/history';

/**
 * One completed session's public history (Increment 4 Task 5 Step 3). The
 * loader returns `null` for a non-member, a foreign session, or an unended one
 * — all rendered as the same 404, never confirming what exists. The payload is
 * a projection of already-sanitized rows: the stamped final PUBLIC state and
 * the public event log. No private card image URL, alt text, JSON, or hidden
 * DOM node can be rendered because none reaches the page. `private, no-store`
 * comes from `requireCampaignAccess`.
 */
export const load: PageServerLoad = async (event) => {
	const role = await requireCampaignAccess(event, event.params.id);
	const db = await getDb(event);

	const history = await loadCompletedSessionHistory(db, event.params.id, event.params.sessionId, role.userId);
	if (history === null) throw error(404, 'Session not found');

	return {
		campaignId: event.params.id,
		history: { ...history, endedAt: history.endedAt.toISOString() }
	};
};
