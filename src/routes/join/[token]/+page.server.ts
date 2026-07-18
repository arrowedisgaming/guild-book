import { error, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getEnv } from '$lib/server/auth';
import {
	installCampaignHeaders,
	requireCampaignFeature
} from '$lib/server/campaign/access';
import {
	joinCampaignWithInvite,
	previewCampaignInvite
} from '$lib/server/campaign/membership';
import { getDb } from '$lib/server/db';

export const load: PageServerLoad = async (event) => {
	installCampaignHeaders(event);
	const session = await event.locals.auth();
	if (!session?.user?.id) {
		throw redirect(302, `/login?callbackUrl=${encodeURIComponent(event.url.pathname)}`);
	}
	const userId = await requireCampaignFeature(event);
	const secret = getEnv(event, 'CAMPAIGN_INVITE_SECRET');
	if (!secret) throw error(503, 'Campaign invitations are unavailable');
	const invitation = await previewCampaignInvite(await getDb(event), {
			token: event.params.token,
			secret,
			userId
		});
	if (!invitation) throw error(404, 'This invitation is no longer available.');
	return { invitation };
};

export const actions: Actions = {
	default: async (event) => {
		const userId = await requireCampaignFeature(event);
		const secret = getEnv(event, 'CAMPAIGN_INVITE_SECRET');
		if (!secret) throw error(503, 'Campaign invitations are unavailable');
		const result = await joinCampaignWithInvite(await getDb(event), {
			token: event.params.token,
			secret,
			userId,
			joinWithoutCharacter: true
		});
		if (!result.ok) throw error(404, 'This invitation is no longer available.');
		throw redirect(303, `/campaigns/${result.campaignId}?joined=observer`);
	}
};
