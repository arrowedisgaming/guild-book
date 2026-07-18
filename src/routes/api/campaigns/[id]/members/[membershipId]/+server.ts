import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { campaignHeaders, requireCampaignAccess } from '$lib/server/campaign/access';
import { removeCampaignMember } from '$lib/server/campaign/membership';
import { getDb } from '$lib/server/db';

export const DELETE: RequestHandler = async (event) => {
	const role = await requireCampaignAccess(event, event.params.id);
	if (role.kind !== 'gm') throw error(404, 'Campaign not found');
	const result = await removeCampaignMember(await getDb(event), {
		campaignId: event.params.id,
		membershipId: event.params.membershipId,
		ownerUserId: role.userId
	});
	if (!result.ok) {
		if (result.reason === 'not-found') throw error(404, 'Campaign not found');
		return json(
			{ message: 'Campaign membership could not be changed' },
			{ status: 409, headers: campaignHeaders() }
		);
	}
	return json(
		{ success: true, membershipId: result.membershipId },
		{ headers: campaignHeaders() }
	);
};
