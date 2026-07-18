import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { campaignHeaders, requireCampaignAccess } from '$lib/server/campaign/access';
import { getDbContext } from '$lib/server/db';
import { executeCommand } from '$lib/server/session/command-service';
import { rejectionStatus } from '$lib/server/session/sanitize';

/**
 * Executes one strict-envelope session command (spec §10.2). Every outcome —
 * accepted, a same-hash duplicate replay, or any rejection — carries the
 * actor's own fresh projection alongside it (never a stored/replayed body
 * for someone else), so this route always returns JSON rather than throwing
 * for the 400/404 cases: throwing would lose that `projection` field.
 * Status per controller amendment 2: `not-authorized` -> 404,
 * `illegal-command`/`content-mismatch`/parse failure -> 400,
 * `stale-structure`/`retry-exhausted`/`command-id-reused` -> 409, accepted
 * (including a duplicate replay) -> 200.
 */
export const POST: RequestHandler = async (event) => {
	const role = await requireCampaignAccess(event, event.params.id);
	const envelope = await readJson(event.request);

	const result = await executeCommand({
		dbContext: await getDbContext(event),
		campaignId: event.params.id,
		sessionId: event.params.sessionId,
		actorUserId: role.userId,
		envelope
	});

	const status = result.outcome.ok ? 200 : rejectionStatus(result.outcome.code);
	return json({ outcome: result.outcome, projection: result.projection }, { status, headers: campaignHeaders() });
};

async function readJson(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		// Not a rejection code from the service (the envelope never reached
		// it) — but the same 400 the strict-parse failure inside
		// `executeCommand` would have produced, so the client sees one
		// consistent "your envelope was invalid" status either way.
		throw error(400, 'Request body is not valid JSON');
	}
}
