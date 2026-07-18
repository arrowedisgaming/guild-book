import type { LayoutServerLoad } from './$types';
import { canAccessCampaignFeature, getCampaignFeatureConfig } from '$lib/server/campaign/config';

// Surfaces the signed-in session (if any) and the app version to every page.
export const load: LayoutServerLoad = async (event) => {
	const session = await event.locals.auth();
	const userId = session?.user?.id ?? null;
	return {
		appVersion: __APP_VERSION__,
		user: session?.user ? { name: session.user.name ?? null, email: session.user.email ?? null } : null,
		showCampaignsNav: Boolean(
			userId && canAccessCampaignFeature(getCampaignFeatureConfig(event), userId)
		)
	};
};
