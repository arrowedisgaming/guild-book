import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { campaignHeaders, requireCampaignAccess } from '$lib/server/campaign/access';
import { getDb, getDbContext } from '$lib/server/db';
import { startSession, type LifecycleRejectionCode } from '$lib/server/session/lifecycle';
import { findOpenSessionForCampaign, listCampaignSessions } from '$lib/server/session/repository';
import { loadProjectionForActor } from '$lib/server/session/command-service';
import { rejectionStatus } from '$lib/server/session/sanitize';

/** Translates a lifecycle rejection code to its HTTP response per
 * controller amendment 2 — `not-authorized` throws 404 (indistinguishable
 * from a nonexistent session, matching Increment 1), `illegal-command`
 * throws 400, `stale-structure` returns a retryable 409. Lifecycle
 * rejections carry no message (`LifecycleRejectionCode` has no `.message`
 * field — see `lifecycle.ts`), so the caller supplies the 400 wording. */
function respondToLifecycleRejection(code: LifecycleRejectionCode, illegalCommandMessage: string): Response {
	const status = rejectionStatus(code);
	if (status === 404) throw error(404, 'Session not found');
	if (status === 400) throw error(400, illegalCommandMessage);
	return json({ message: 'Session changed — refetch and retry', code }, { status: 409, headers: campaignHeaders() });
}

/** Starts a new session for the campaign. GM-only — `startSession` itself
 * enforces this (`not-authorized` -> 404 per amendment 2), so the route adds
 * no redundant role check. */
export const POST: RequestHandler = async (event) => {
	const role = await requireCampaignAccess(event, event.params.id);
	const dbContext = await getDbContext(event);

	const result = await startSession({ dbContext, campaignId: event.params.id, actorUserId: role.userId });
	if (!result.ok) {
		return respondToLifecycleRejection(result.code, 'A session is already active or frozen for this campaign');
	}

	const db = await getDb(event);
	const projection = await loadProjectionForActor(db, result.sessionId, event.params.id, {
		kind: role.kind,
		userId: role.userId
	});
	return json({ sessionId: result.sessionId, session: projection }, { status: 201, headers: campaignHeaders() });
};

/** Lists this campaign's session history: a lightweight summary of any
 * currently open (active/frozen) session, plus every ended session's
 * sanitized public-history pointer. The full projection/history body lives
 * at `GET /sessions/[sessionId]` — this listing stays small on purpose. */
export const GET: RequestHandler = async (event) => {
	await requireCampaignAccess(event, event.params.id);
	const db = await getDb(event);

	const [current, sessions] = await Promise.all([
		findOpenSessionForCampaign(db, event.params.id),
		listCampaignSessions(db, event.params.id)
	]);

	const history = sessions
		.filter((session) => session.status === 'ended')
		.map((session) => ({
			sessionId: session.sessionId,
			sequence: session.sequence,
			startedAt: session.startedAt,
			endedAt: session.endedAt,
			publicHistoryChecksum: session.publicHistoryChecksum
		}));

	return json({ current, history }, { headers: campaignHeaders() });
};
