import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { campaignHeaders, requireCampaignAccess } from '$lib/server/campaign/access';
import { getDbContext } from '$lib/server/db';
import { executeCorrectionCommand } from '$lib/server/session/correction-command-service';
import { rejectionStatus } from '$lib/server/session/sanitize';

/** Applies one GM compensating correction (Increment 4 Task 5). */
export const POST: RequestHandler = async (event) => {
	const role = await requireCampaignAccess(event, event.params.id);
	const envelope = await readJson(event.request);

	const result = await executeCorrectionCommand({
		dbContext: await getDbContext(event),
		campaignId: event.params.id,
		sessionId: event.params.sessionId,
		actorUserId: role.userId,
		envelope
	});

	const status = result.outcome.ok ? 200 : rejectionStatus(result.outcome.code);
	return json(
		{ recipientUserId: role.userId, outcome: result.outcome, projection: result.projection },
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
