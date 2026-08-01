import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { campaignHeaders, requireCampaignAccess } from '$lib/server/campaign/access';
import { getDbContext } from '$lib/server/db';
import { executeChallengeCommand } from '$lib/server/session/challenge-command-service';
import { rejectionStatus } from '$lib/server/session/sanitize';

/**
 * Executes one Challenge command (Increment 3 Task 6) — the guided
 * Challenge table's own command surface, parallel to (never a replacement
 * for) `POST .../commands`'s generic `SessionCommand` route. Same response
 * shape/status discipline as that route (controller amendment 2 — see its
 * own doc comment): every outcome carries the actor's own fresh projections
 * (both the generic session projection AND the Challenge-specific slice)
 * so this always returns JSON rather than throwing for 400/404 cases.
 */
export const POST: RequestHandler = async (event) => {
	const role = await requireCampaignAccess(event, event.params.id);
	const envelope = await readJson(event.request);

	const result = await executeChallengeCommand({
		dbContext: await getDbContext(event),
		campaignId: event.params.id,
		sessionId: event.params.sessionId,
		actorUserId: role.userId,
		envelope
	});

	const status = result.outcome.ok ? 200 : rejectionStatus(result.outcome.code);
	return json(
		{
			recipientUserId: role.userId,
			outcome: result.outcome,
			projection: result.projection,
			challengeProjection: result.challengeProjection,
			challengeLegalCommands: result.challengeLegalCommands
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
