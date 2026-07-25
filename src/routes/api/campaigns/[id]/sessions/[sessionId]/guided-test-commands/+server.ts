import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { campaignHeaders, requireCampaignAccess } from '$lib/server/campaign/access';
import { getDbContext } from '$lib/server/db';
import { executeGuidedTestCommand } from '$lib/server/session/guided-test-command-service';
import { rejectionStatus } from '$lib/server/session/sanitize';

/**
 * Executes one guided test-of-fate command (Increment 4 Task 2) — the guided
 * test's own command surface, parallel to (never a replacement for) `POST
 * .../commands`'s generic `SessionCommand` route and `POST
 * .../challenge-commands`. Same response shape/status discipline as both: every
 * outcome carries the actor's own fresh projections (the generic session
 * projection AND the guided-test slice) so this always returns JSON rather than
 * throwing for 400/404 cases.
 */
export const POST: RequestHandler = async (event) => {
	const role = await requireCampaignAccess(event, event.params.id);
	const envelope = await readJson(event.request);

	const result = await executeGuidedTestCommand({
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
			guidedTestProjection: result.guidedTestProjection,
			guidedTestLegalCommands: result.guidedTestLegalCommands
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
