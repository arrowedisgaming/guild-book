import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { getEnv } from '$lib/server/auth';
import { campaignHeaders, requireCampaignFeature } from '$lib/server/campaign/access';
import { joinCampaignWithInvite } from '$lib/server/campaign/membership';
import { getDb } from '$lib/server/db';

const joinSchema = z
	.object({
		characterId: z.string().trim().min(1).max(128).optional(),
		joinWithoutCharacter: z.literal(true).optional()
	})
	.refine((value) => Boolean(value.characterId) || value.joinWithoutCharacter === true, {
		message: 'Choose an adventurer or explicitly join without one'
	});

export const POST: RequestHandler = async (event) => {
	const userId = await requireCampaignFeature(event);
	const parsed = joinSchema.safeParse(await readJson(event.request));
	if (!parsed.success) throw error(400, 'Invalid join request');
	const secret = getEnv(event, 'CAMPAIGN_INVITE_SECRET');
	if (!secret) throw error(503, 'Campaign invitations are unavailable');

	const result = await joinCampaignWithInvite(await getDb(event), {
		token: event.params.token,
		secret,
		userId,
		...parsed.data
	});
	if (!result.ok) throw error(404, 'Campaign not found');
	return json(result, {
		status: result.created ? 201 : 200,
		headers: campaignHeaders()
	});
};

async function readJson(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		throw error(400, 'Request body is not valid JSON');
	}
}
