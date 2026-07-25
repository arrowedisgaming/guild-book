import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { campaignHeaders, requireCampaignAccess } from '$lib/server/campaign/access';
import { getDbContext } from '$lib/server/db';
import { executeCampCommand } from '$lib/server/session/camp-command-service';
import { rejectionStatus } from '$lib/server/session/sanitize';

/**
 * Executes one Camp command (Increment 4 Task 3) — High Chant and leeches, the
 * two Camp Actions whose mechanics are card operations. Parallel to (never a
 * replacement for) the generic `.../commands` route and the Challenge and
 * guided-test surfaces. Same response shape and status discipline as those:
 * every outcome carries the actor's own fresh projections, so this returns JSON
 * rather than throwing for 400/404 cases.
 */
export const POST: RequestHandler = async (event) => {
	const role = await requireCampaignAccess(event, event.params.id);
	const envelope = await readJson(event.request);

	const result = await executeCampCommand({
		dbContext: await getDbContext(event),
		campaignId: event.params.id,
		sessionId: event.params.sessionId,
		actorUserId: role.userId,
		envelope
	});

	const status = result.outcome.ok ? 200 : rejectionStatus(result.outcome.code);
	return json(
		{
			outcome: result.outcome,
			projection: result.projection,
			campProjection: result.campProjection,
			campLegalCommands: result.campLegalCommands
		},
		{ status, headers: campaignHeaders() }
	);
};

async function readJson(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		throw error(400, 'Request body is not valid JSON');
	}
}
