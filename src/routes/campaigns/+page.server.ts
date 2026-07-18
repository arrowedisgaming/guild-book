import type { PageServerLoad } from './$types';
import { requireCampaignFeature } from '$lib/server/campaign/access';
import { listCampaignsForUser } from '$lib/server/campaign/service';
import { getDb } from '$lib/server/db';

export const load: PageServerLoad = async (event) => {
	const userId = await requireCampaignFeature(event);
	return { campaigns: await listCampaignsForUser(await getDb(event), userId) };
};
