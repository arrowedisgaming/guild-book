import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { campaignHeaders, requireCampaignAccess } from '$lib/server/campaign/access';
import { getDbContext } from '$lib/server/db';
import { executeFiniteCommand } from '$lib/server/session/finite-command-service';
import { rejectionStatus } from '$lib/server/session/sanitize';

/**
 * Executes one finite-runner command (Increment 4 Task 4) — the data-driven
 * Crawl/City/sorcery/Camp-watch procedures. Parallel to the generic,
 * Challenge, guided-test, and Camp surfaces; same response shape and status
 * discipline as all of them.
 */
export const POST: RequestHandler = async (event) => {
	const role = await requireCampaignAccess(event, event.params.id);
	const envelope = await readJson(event.request);

	const result = await executeFiniteCommand({
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
			finiteProjection: result.finiteProjection,
			finiteLegalCommands: result.finiteLegalCommands
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
