import { error, type RequestEvent } from '@sveltejs/kit';
import { and, eq, isNull } from 'drizzle-orm';
import { ensureUser } from '$lib/server/auth';
import { getDb } from '$lib/server/db';
import { campaignMembers, campaigns } from '$lib/server/db/schema';
import { canAccessCampaignFeature, getCampaignFeatureConfig } from './config';

export type CampaignRole =
	| { kind: 'gm'; userId: string; campaignId: string }
	| { kind: 'player'; userId: string; campaignId: string; membershipId: string };

/** Resolve one active campaign role or hide every denial behind the same 404. */
export async function requireCampaignAccess(
	event: RequestEvent,
	campaignId: string
): Promise<CampaignRole> {
	let userId: string;
	try {
		userId = await ensureUser(event);
	} catch {
		throw campaignNotFound();
	}

	if (!canAccessCampaignFeature(getCampaignFeatureConfig(event), userId)) {
		throw campaignNotFound();
	}

	const db = await getDb(event);
	const access = await db
		.select({
			campaignId: campaigns.id,
			ownerUserId: campaigns.ownerUserId,
			membershipId: campaignMembers.id
		})
		.from(campaigns)
		.leftJoin(
			campaignMembers,
			and(
				eq(campaignMembers.campaignId, campaigns.id),
				eq(campaignMembers.userId, userId),
				isNull(campaignMembers.leftAt),
				isNull(campaignMembers.removedAt)
			)
		)
		.where(and(eq(campaigns.id, campaignId), isNull(campaigns.archivedAt)))
		.get();

	if (!access) throw campaignNotFound();
	if (access.ownerUserId === userId) {
		return { kind: 'gm', userId, campaignId: access.campaignId };
	}
	if (access.membershipId) {
		return {
			kind: 'player',
			userId,
			campaignId: access.campaignId,
			membershipId: access.membershipId
		};
	}

	throw campaignNotFound();
}

export function campaignHeaders(): HeadersInit {
	return { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
}

function campaignNotFound() {
	return error(404, 'Campaign not found');
}
