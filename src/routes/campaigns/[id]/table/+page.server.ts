import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireCampaignAccess } from '$lib/server/campaign/access';
import { loadCampaignProjection } from '$lib/server/campaign/service';
import { loadActiveChallengeRoster } from '$lib/server/campaign/page-data';
import { getDenizenThreats, getTarotProcedures } from '$lib/server/content/loader';
import { getDb, getDbContext } from '$lib/server/db';
import { startSession } from '$lib/server/session/lifecycle';
import { loadTableProjectionsForActor } from '$lib/server/session/table-projections';
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
	const [campaign, cursor, openSession, challengeRoster] = await Promise.all([
		loadCampaignProjection(db, role),
		campaignCursor(db, event.params.id),
		findOpenSessionForCampaign(db, event.params.id),
		// GM-only UI need (the "Begin Challenge" roster picker), but cheap
		// enough and non-secret enough (campaign membership, not private hand
		// state) to fetch unconditionally rather than branch on role.
		loadActiveChallengeRoster(db, event.params.id)
	]);
	if (!campaign) throw error(404, 'Campaign not found');

	let session: SessionSyncSnapshot['session'] = null;
	// An open session that cannot be projected is NOT the same as no session,
	// and the page must not conflate them: the unloadable session still holds
	// the campaign's one open-session slot, so offering "Start session" here
	// hands the GM a button whose action can only ever refuse with a 409.
	let sessionUnavailable = false;
	if (openSession) {
		const {
			projection: envelope,
			challengeProjection,
			challengeLegalCommands,
			guidedTestProjection,
			guidedTestLegalCommands,
			campProjection,
			campLegalCommands,
			finiteProjection,
			finiteLegalCommands,
			loadFailure
		} = await loadTableProjectionsForActor(
			db,
			openSession.sessionId,
			event.params.id,
			{ kind: role.kind, userId: role.userId }
		);
		sessionUnavailable = loadFailure === 'unloadable';
		if (envelope) {
			session = {
				sessionId: openSession.sessionId,
				status: openSession.status,
				sessionVersion: envelope.sessionVersion,
				campaignCursor: envelope.campaignCursor,
				projection: envelope.projection,
				challengeProjection,
				challengeLegalCommands,
				guidedTestProjection,
				guidedTestLegalCommands,
				campProjection,
				campLegalCommands,
				finiteProjection,
				finiteLegalCommands
			};
		}
	}

	const initial: SessionSyncSnapshot = { cursor, events: [], session };

	// The GM's "Begin Challenge" enemy-fact form needs the real `threat`
	// values (review round: previously free text, so a typo like `Elite`
	// silently scored as no threat at all — `deal.ts`'s
	// `calculateGmHandSize` compares exactly against these ids). Sourced from
	// `denizens.json`'s own `threats` catalog, never re-typed in the
	// component. Trivial/cached, safe to compute unconditionally.
	const enemyThreatOptions = getDenizenThreats().map((threat) => ({ id: threat.id, name: threat.name }));
	// Display names for the finite panels' pickers. Titles only — the server
	// resolves every command against the session's PINNED content, so a
	// mid-campaign pack update can at worst mislabel a button, never change a
	// live session's rules.
	const procedureTitles = getTarotProcedures().procedures.map((procedure) => ({
		id: procedure.id,
		title: procedure.title,
		phase: procedure.phase
	}));

	return {
		procedureTitles,
		campaignId: event.params.id,
		campaignName: campaign.name,
		role: role.kind,
		userId: role.userId,
		challengeRoster,
		enemyThreatOptions,
		sessionUnavailable,
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
		if (!result.ok) {
			// `illegal-command` from `startSession` has exactly one cause: this
			// campaign already has an active or frozen session. Saying so is
			// worth more than the old catch-all, because the most likely way a
			// GM reaches it is an open session the table could not load and so
			// did not show them.
			const message =
				result.code === 'illegal-command'
					? 'This campaign already has an open session, so a new one cannot be started.'
					: 'A session could not be started.';
			return fail(409, { message });
		}
		return { success: 'session-started' };
	}
};
