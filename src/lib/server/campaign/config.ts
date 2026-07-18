import type { RequestEvent } from '@sveltejs/kit';
import { getEnv } from '$lib/server/auth';

export interface CampaignFeatureConfig {
	enabled: boolean;
	pilotUserIds: ReadonlySet<string>;
}

export function canAccessCampaignFeature(
	config: CampaignFeatureConfig,
	userId: string
): boolean {
	return config.enabled || config.pilotUserIds.has(userId);
}

/** Server-only campaign rollout configuration; never return this in page data. */
export function getCampaignFeatureConfig(event: RequestEvent): CampaignFeatureConfig {
	const pilotUserIds = new Set(
		(getEnv(event, 'CAMPAIGNS_PILOT_USER_IDS') ?? '')
			.split(',')
			.map((value) => value.trim())
			.filter(Boolean)
	);

	return {
		enabled: isFlagOn(getEnv(event, 'CAMPAIGNS_ENABLED')),
		pilotUserIds
	};
}

function isFlagOn(value: string | undefined): boolean {
	if (!value) return false;
	return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}
