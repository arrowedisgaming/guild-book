import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { campaignHeaders, requireCampaignAccess } from '$lib/server/campaign/access';
import { getDb } from '$lib/server/db';
import { executeChallengeDeath, type ChallengeDeathFailureReason } from '$lib/server/session/command-service';
import { loadChallengeProjectionsForActor } from '$lib/server/session/challenge-command-service';
import { resolveSessionActor } from '$lib/server/session/repository';

/**
 * Marks a participating adventurer's tenure dead within an active Challenge
 * round (Increment 3 Task 5 surface, wired at the branch-fix wave, I3). This is
 * the replacement path the human decided to wire now rather than ship dormant:
 * `life.ts`'s `markCharacterDead` deliberately rejects a live Challenge
 * participant with `is-challenge-participant` and delegates here, so the whole
 * death — character life JSON, tenure end, membership eligibility, AND the
 * session-engine redaction of the tenure's Challenge zones/seat/hand — commits
 * atomically through `executeChallengeDeath`.
 *
 * GM-only: only the campaign owner may end a seated adventurer mid-Challenge.
 * Every outcome is a typed JSON reason (never a bare 500), plus the actor's
 * fresh projections so the table updates in place.
 */
const bodySchema = z.object({ tenureId: z.string().trim().min(1).max(128) }).strict();

const STATUS_BY_REASON: Record<ChallengeDeathFailureReason, number> = {
	'not-found': 404,
	'not-authorized': 403,
	'illegal-command': 409,
	'version-conflict': 409,
	conflict: 409
};

export const POST: RequestHandler = async (event) => {
	const role = await requireCampaignAccess(event, event.params.id);
	if (role.kind !== 'gm') throw error(404, 'Campaign not found');

	const parsed = bodySchema.safeParse(await readJson(event.request));
	if (!parsed.success) throw error(400, 'Invalid death command');

	const db = await getDb(event);
	const outcome = await executeChallengeDeath({
		db,
		campaignId: event.params.id,
		sessionId: event.params.sessionId,
		tenureId: parsed.data.tenureId,
		actorUserId: role.userId
	});

	const actor = await resolveSessionActor(db, event.params.id, role.userId);
	const projections = actor
		? await loadChallengeProjectionsForActor(db, event.params.sessionId, event.params.id, actor)
		: { projection: null, challengeProjection: null, challengeLegalCommands: [] };

	const status = outcome.ok ? 200 : STATUS_BY_REASON[outcome.reason];
	return json({ outcome, ...projections }, { status, headers: campaignHeaders() });
};

async function readJson(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		throw error(400, 'Request body is not valid JSON');
	}
}
