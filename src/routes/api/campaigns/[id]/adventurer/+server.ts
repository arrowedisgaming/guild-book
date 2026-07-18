import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { campaignHeaders, requireCampaignAccess } from '$lib/server/campaign/access';
import { attachAdventurer, replaceAdventurer } from '$lib/server/campaign/tenure';
import { getDb } from '$lib/server/db';

const commandSchema = z.object({
	action: z.enum(['attach', 'replace']),
	characterId: z.string().trim().min(1).max(128)
});

export const POST: RequestHandler = async (event) => {
	const role = await requireCampaignAccess(event, event.params.id);
	if (role.kind !== 'player') throw error(404, 'Campaign not found');
	const parsed = commandSchema.safeParse(await readJson(event.request));
	if (!parsed.success) throw error(400, 'Invalid adventurer command');

	const service = parsed.data.action === 'replace' ? replaceAdventurer : attachAdventurer;
	const result = await service(await getDb(event), {
		campaignId: event.params.id,
		membershipId: role.membershipId,
		actorUserId: role.userId,
		characterId: parsed.data.characterId
	});
	if (!result.ok) {
		if (result.reason === 'membership-not-found') throw error(404, 'Campaign not found');
		return json(
			{ message: 'Adventurer could not be attached', reason: result.reason },
			{ status: 409, headers: campaignHeaders() }
		);
	}
	return json({ success: true, ...result }, { headers: campaignHeaders() });
};

async function readJson(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		throw error(400, 'Request body is not valid JSON');
	}
}
