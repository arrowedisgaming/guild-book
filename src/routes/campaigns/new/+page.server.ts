import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getEnv } from '$lib/server/auth';
import { requireCampaignFeature } from '$lib/server/campaign/access';
import { createCampaign } from '$lib/server/campaign/service';
import { getDb } from '$lib/server/db';
import { createCampaignSchema } from '$lib/schemas/campaign.schema';

export const load: PageServerLoad = async (event) => {
	await requireCampaignFeature(event);
	return {};
};

export const actions: Actions = {
	default: async (event) => {
		const userId = await requireCampaignFeature(event);
		const formData = await event.request.formData();
		const parsed = createCampaignSchema.safeParse({
			name: formData.get('name'),
			description: formData.get('description')
		});
		if (!parsed.success) {
			return fail(400, {
				message: parsed.error.issues.map((issue) => issue.message).join(', '),
				name: String(formData.get('name') ?? ''),
				description: String(formData.get('description') ?? '')
			});
		}
		const inviteSecret = getEnv(event, 'CAMPAIGN_INVITE_SECRET');
		if (!inviteSecret) throw error(503, 'Campaign invitations are unavailable');
		const created = await createCampaign(await getDb(event), {
			ownerUserId: userId,
			name: parsed.data.name,
			description: parsed.data.description,
			inviteSecret
		});
		throw redirect(303, `/campaigns/${created.campaign.id}`);
	}
};
