import type { LayoutServerLoad } from './$types';
import { getEnv } from '$lib/server/auth';
import { canAccessCampaignFeature, getCampaignFeatureConfig } from '$lib/server/campaign/config';
import { getContentPack } from '$lib/server/content/loader';

// Surfaces the signed-in session (if any) and the app version to every page.
export const load: LayoutServerLoad = async (event) => {
	const session = await event.locals.auth();
	const userId = session?.user?.id ?? null;
	return {
		appVersion: __APP_VERSION__,
		user: session?.user ? { name: session.user.name ?? null, email: session.user.email ?? null } : null,
		showCampaignsNav: Boolean(
			userId && canAccessCampaignFeature(getCampaignFeatureConfig(event), userId)
		),
		// A plain URL, safe to expose. Read through `getEnv` like every other
		// setting so Cloudflare bindings and process.env share one code path.
		feedbackUrl: getEnv(event, 'FEEDBACK_URL') ?? null,
		packVersion: getContentPack().version
	};
};
