import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireCampaignAccess } from '$lib/server/campaign/access';
import { loadCampaignProjection } from '$lib/server/campaign/service';
import { getDb, getDbContext } from '$lib/server/db';
import { startSession } from '$lib/server/session/lifecycle';
import { loadProjectionForActor } from '$lib/server/session/command-service';
import { campaignCursor, findOpenSessionForCampaign } from '$lib/server/session/repository';
import type { SessionSyncSnapshot } from '$lib/stores/campaign-session.svelte';

/**
 * Guards the table exactly like every other campaign page (controller
 * amendment 3 — `CAMPAIGNS_ENABLED` + membership via `requireCampaignAccess`,
 * same 404 for a nonmember/disabled flag/archived campaign) and builds the
 * initial sync snapshot the client store hydrates from: the same
 * `{cursor, events, session}` shape `GET /sync` returns, built from the same
 * repository/`loadProjectionForActor` reads that route uses, so the client
 * never has to reconcile two different projection builders. `events` starts
 * empty — there is nothing to "catch up on" as of a fresh SSR load.
 */
export const load: PageServerLoad = async (event) => {
	const role = await requireCampaignAccess(event, event.params.id);
	const db = await getDb(event);
	const [campaign, cursor, openSession] = await Promise.all([
		loadCampaignProjection(db, role),
		campaignCursor(db, event.params.id),
		findOpenSessionForCampaign(db, event.params.id)
	]);
	if (!campaign) throw error(404, 'Campaign not found');

	let session: SessionSyncSnapshot['session'] = null;
	if (openSession) {
		const envelope = await loadProjectionForActor(db, openSession.sessionId, event.params.id, {
			kind: role.kind,
			userId: role.userId
		});
		if (envelope) {
			session = {
				sessionId: openSession.sessionId,
				status: openSession.status,
				sessionVersion: envelope.sessionVersion,
				campaignCursor: envelope.campaignCursor,
				projection: envelope.projection
			};
		}
	}

	const initial: SessionSyncSnapshot = { cursor, events: [], session };

	return {
		campaignId: event.params.id,
		campaignName: campaign.name,
		role: role.kind,
		userId: role.userId,
		initial
	};
};

export const actions: Actions = {
	/** GM-only: starts a new session for this campaign (Task 5's lifecycle
	 * service already enforces GM-only via `not-authorized`; the explicit role
	 * check here just gets there without a round trip). A plain form action —
	 * no client JS required, and the resulting full-page reload is the GM's
	 * *own* navigation, not the "no manual refresh" requirement (that's about
	 * every other client, which picks the new session up via their own
	 * store's poll). */
	start: async (event) => {
		const role = await requireCampaignAccess(event, event.params.id);
		if (role.kind !== 'gm') throw error(404, 'Campaign not found');

		const result = await startSession({
			dbContext: await getDbContext(event),
			campaignId: event.params.id,
			actorUserId: role.userId
		});
		if (!result.ok) return fail(409, { message: 'A session could not be started.' });
		return { success: 'session-started' };
	}
};
