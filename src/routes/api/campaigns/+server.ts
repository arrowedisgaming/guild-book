import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getEnv } from '$lib/server/auth';
import { campaignHeaders, requireCampaignFeature } from '$lib/server/campaign/access';
import { createCampaign, listCampaignsForUser } from '$lib/server/campaign/service';
import { getDb } from '$lib/server/db';
import { createCampaignSchema } from '$lib/schemas/campaign.schema';

export const GET: RequestHandler = async (event) => {
	const userId = await requireCampaignFeature(event);
	const campaigns = await listCampaignsForUser(await getDb(event), userId);
	return json({ campaigns }, { headers: campaignHeaders() });
};

export const POST: RequestHandler = async (event) => {
	const userId = await requireCampaignFeature(event);
	const parsed = createCampaignSchema.safeParse(await readJson(event.request));
	if (!parsed.success) throw error(400, formatValidationError(parsed.error.issues));

	const inviteSecret = getEnv(event, 'CAMPAIGN_INVITE_SECRET');
	if (!inviteSecret) throw error(503, 'Campaign invitations are unavailable');
	const created = await createCampaign(await getDb(event), {
		ownerUserId: userId,
		name: parsed.data.name,
		description: parsed.data.description,
		inviteSecret
	});
	return json(created, { status: 201, headers: campaignHeaders() });
};

async function readJson(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		throw error(400, 'Request body is not valid JSON');
	}
}

function formatValidationError(issues: Array<{ message: string }>): string {
	return `Invalid campaign data: ${issues.map((issue) => issue.message).join(', ')}`;
}
