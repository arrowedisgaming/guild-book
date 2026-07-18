import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { campaignHeaders, requireCampaignFeature } from '$lib/server/campaign/access';
import { correctCharacterDeath, markCharacterDead } from '$lib/server/character/life';
import { getDb } from '$lib/server/db';

const commandSchema = z.discriminatedUnion('action', [
	z.object({
		action: z.literal('mark-dead'),
		expectedVersion: z.number().int().positive(),
		campaignId: z.string().trim().min(1).max(128).optional()
	}),
	z.object({
		action: z.literal('correct-death'),
		expectedVersion: z.number().int().positive()
	})
]);

export const PATCH: RequestHandler = async (event) => {
	const userId = await requireCampaignFeature(event);
	const parsed = commandSchema.safeParse(await readJson(event.request));
	if (!parsed.success) throw error(400, 'Invalid life-state command');
	const db = await getDb(event);
	const result =
		parsed.data.action === 'mark-dead'
			? await markCharacterDead(db, {
					characterId: event.params.id,
					actorUserId: userId,
					expectedVersion: parsed.data.expectedVersion,
					...(parsed.data.campaignId ? { campaignId: parsed.data.campaignId } : {})
				})
			: await correctCharacterDeath(db, {
					characterId: event.params.id,
					actorUserId: userId,
					expectedVersion: parsed.data.expectedVersion
				});
	if (!result.ok) {
		if (result.reason === 'not-found') throw error(404, 'Character not found');
		if (result.reason === 'version-conflict') {
			return json(
				{ message: 'Character changed — refetch and retry', currentVersion: result.currentVersion },
				{ status: 409, headers: campaignHeaders() }
			);
		}
		return json(
			{ message: 'Character life state could not be changed', reason: result.reason },
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
