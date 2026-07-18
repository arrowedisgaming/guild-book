import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getEnv } from '$lib/server/auth';
import { campaignHeaders, requireCampaignAccess } from '$lib/server/campaign/access';
import {
	closeCampaignInvite,
	getCampaignInvite,
	openCampaignInvite,
	rotateCampaignInvite
} from '$lib/server/campaign/service';
import { getDb } from '$lib/server/db';

export const GET: RequestHandler = async (event) => {
	const role = await requireOwner(event);
	const result = await getCampaignInvite(await getDb(event), {
		campaignId: event.params.id,
		ownerUserId: role.userId,
		secret: requireInviteSecret(event)
	});
	if (!result.ok) {
		if (result.reason === 'not-found') throw error(404, 'Campaign not found');
		return json({ message: 'Campaign invitations are closed' }, { status: 409, headers: campaignHeaders() });
	}
	return json({ token: result.token, version: result.version }, { headers: campaignHeaders() });
};

export const POST: RequestHandler = async (event) => {
	const role = await requireOwner(event);
	const result = await rotateCampaignInvite(await getDb(event), {
		campaignId: event.params.id,
		ownerUserId: role.userId,
		secret: requireInviteSecret(event)
	});
	if (!result.ok) {
		if (result.reason === 'not-found') throw error(404, 'Campaign not found');
		return json({ message: 'Invite changed — retry' }, { status: 409, headers: campaignHeaders() });
	}
	return json({ token: result.token, version: result.version }, { headers: campaignHeaders() });
};

export const PATCH: RequestHandler = async (event) => {
	const role = await requireOwner(event);
	const result = await openCampaignInvite(await getDb(event), {
		campaignId: event.params.id,
		ownerUserId: role.userId,
		secret: requireInviteSecret(event)
	});
	if (!result.ok) {
		if (result.reason === 'not-found') throw error(404, 'Campaign not found');
		return json(
			{ message: 'Invite changed — refetch and retry' },
			{ status: 409, headers: campaignHeaders() }
		);
	}
	return json({ token: result.token, version: result.version }, { headers: campaignHeaders() });
};

export const DELETE: RequestHandler = async (event) => {
	const role = await requireOwner(event);
	const result = await closeCampaignInvite(await getDb(event), {
		campaignId: event.params.id,
		ownerUserId: role.userId
	});
	if (!result.ok) throw error(404, 'Campaign not found');
	return json({ success: true }, { headers: campaignHeaders() });
};

async function requireOwner(event: Parameters<RequestHandler>[0]) {
	const role = await requireCampaignAccess(event, event.params.id);
	if (role.kind !== 'gm') throw error(404, 'Campaign not found');
	return role;
}

function requireInviteSecret(event: Parameters<RequestHandler>[0]): string {
	const secret = getEnv(event, 'CAMPAIGN_INVITE_SECRET');
	if (!secret) throw error(503, 'Campaign invitations are unavailable');
	return secret;
}
