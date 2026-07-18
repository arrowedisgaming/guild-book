import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	campaignHeaders,
	requireCampaignAccess,
	requireCampaignReadAccess
} from '$lib/server/campaign/access';
import { loadCampaignProjection, updateCampaignMetadata } from '$lib/server/campaign/service';
import { archiveCampaign } from '$lib/server/campaign/membership';
import { getDb } from '$lib/server/db';
import { updateCampaignSchema } from '$lib/schemas/campaign.schema';

export const GET: RequestHandler = async (event) => {
	const role = await requireCampaignReadAccess(event, event.params.id);
	const campaign = await loadCampaignProjection(await getDb(event), role);
	if (!campaign) throw error(404, 'Campaign not found');
	return json({ campaign }, { headers: campaignHeaders() });
};

export const PATCH: RequestHandler = async (event) => {
	const role = await requireCampaignAccess(event, event.params.id);
	if (role.kind !== 'gm') throw error(404, 'Campaign not found');

	const parsed = updateCampaignSchema.safeParse(await readJson(event.request));
	if (!parsed.success) throw error(400, formatValidationError(parsed.error.issues));
	const result = await updateCampaignMetadata(await getDb(event), {
		campaignId: event.params.id,
		ownerUserId: role.userId,
		...parsed.data
	});
	if (!result.ok) {
		if (result.reason === 'not-found') throw error(404, 'Campaign not found');
		return json(
			{ message: 'Campaign changed — refetch and retry', currentVersion: result.currentVersion },
			{ status: 409, headers: campaignHeaders() }
		);
	}
	return json({ success: true, version: result.version }, { headers: campaignHeaders() });
};

export const DELETE: RequestHandler = async (event) => {
	const role = await requireCampaignAccess(event, event.params.id);
	if (role.kind !== 'gm') throw error(404, 'Campaign not found');
	const result = await archiveCampaign(await getDb(event), {
		campaignId: event.params.id,
		ownerUserId: role.userId
	});
	if (!result.ok) {
		if (result.reason === 'not-found') throw error(404, 'Campaign not found');
		return json(
			{ message: 'Campaign cannot be archived during an active session' },
			{ status: 409, headers: campaignHeaders() }
		);
	}
	return json({ success: true }, { headers: campaignHeaders() });
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
