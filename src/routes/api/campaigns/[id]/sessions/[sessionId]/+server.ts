import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { campaignHeaders, requireCampaignAccess } from '$lib/server/campaign/access';
import { getDb, getDbContext } from '$lib/server/db';
import { endSession, freezeSession, recoverSession, type LifecycleRejectionCode } from '$lib/server/session/lifecycle';
import { loadEndedSessionHistory, loadSessionSummary } from '$lib/server/session/repository';
import { loadProjectionForActor } from '$lib/server/session/command-service';
import { rejectionStatus } from '$lib/server/session/sanitize';

const patchSchema = z
	.object({
		action: z.enum(['freeze', 'recover', 'end']),
		expectedVersion: z.number().int().nonnegative().optional()
	})
	.strict();

/** Reads either the live role-scoped projection (active/frozen session) or
 * the sanitized completed public history (ended session) for one session.
 * Session existence/campaign match is checked directly (not via a rejection
 * code) because a plain read has no command/lifecycle outcome to translate —
 * a missing or mismatched session is just a 404, same as Increment 1's
 * "actor cannot know about it" convention. */
export const GET: RequestHandler = async (event) => {
	const role = await requireCampaignAccess(event, event.params.id);
	const db = await getDb(event);

	const summary = await loadSessionSummary(db, event.params.sessionId);
	if (!summary || summary.campaignId !== event.params.id) throw error(404, 'Session not found');

	if (summary.status === 'ended') {
		const history = await loadEndedSessionHistory(db, event.params.sessionId);
		if (!history) throw error(404, 'Session not found');
		return json({ status: 'ended', session: history }, { headers: campaignHeaders() });
	}

	const projection = await loadProjectionForActor(db, event.params.sessionId, event.params.id, {
		kind: role.kind,
		userId: role.userId
	});
	if (!projection) throw error(404, 'Session not found');
	return json({ status: summary.status, session: projection }, { headers: campaignHeaders() });
};

/** GM-only structural lifecycle transitions: manually freeze an active
 * session, recover a frozen session back to active, or end an active/frozen
 * session. All three go through Task 5's `lifecycle.ts`, which claims a
 * version exactly like an in-band structural command — no session logic
 * lives here beyond parsing and translating the result. `freeze`/`recover`
 * return the GM's fresh projection (the session is still readable
 * afterward, exercising the fragment-version-stamp fix in
 * `repository.ts`'s `fragmentVersionStampStatements`); `end` returns the
 * public-history checksum instead, since there's no longer a live
 * projection to read. */
export const PATCH: RequestHandler = async (event) => {
	const role = await requireCampaignAccess(event, event.params.id);
	const dbContext = await getDbContext(event);

	const parsed = patchSchema.safeParse(await readJson(event.request));
	if (!parsed.success) throw error(400, 'Invalid lifecycle command');

	if (parsed.data.action === 'freeze') {
		const result = await freezeSession({
			dbContext,
			campaignId: event.params.id,
			sessionId: event.params.sessionId,
			actorUserId: role.userId,
			expectedVersion: parsed.data.expectedVersion
		});
		if (!result.ok) return respondToLifecycleRejection(result.code);
		return json({ success: true, action: 'freeze', session: await freshProjection() }, { headers: campaignHeaders() });
	}

	if (parsed.data.action === 'recover') {
		const result = await recoverSession({
			dbContext,
			campaignId: event.params.id,
			sessionId: event.params.sessionId,
			actorUserId: role.userId,
			expectedVersion: parsed.data.expectedVersion
		});
		if (!result.ok) return respondToLifecycleRejection(result.code);
		return json({ success: true, action: 'recover', session: await freshProjection() }, { headers: campaignHeaders() });
	}

	const result = await endSession({
		dbContext,
		campaignId: event.params.id,
		sessionId: event.params.sessionId,
		actorUserId: role.userId,
		expectedVersion: parsed.data.expectedVersion
	});
	if (!result.ok) return respondToLifecycleRejection(result.code);
	return json(
		{ success: true, action: 'end', publicHistoryChecksum: result.publicHistoryChecksum },
		{ headers: campaignHeaders() }
	);

	async function freshProjection() {
		const db = await getDb(event);
		return loadProjectionForActor(db, event.params.sessionId, event.params.id, { kind: role.kind, userId: role.userId });
	}
};

/** Translates a lifecycle rejection code to its HTTP response per
 * controller amendment 2. `LifecycleRejectionCode` carries no message (see
 * `lifecycle.ts`), so the body is a fixed, non-specific, non-secret string —
 * never anything derived from session state. */
function respondToLifecycleRejection(code: LifecycleRejectionCode): Response {
	const status = rejectionStatus(code);
	if (status === 404) throw error(404, 'Session not found');
	if (status === 400) throw error(400, 'This action is not allowed for the session in its current state');
	return json({ message: 'Session changed — refetch and retry', code }, { status: 409, headers: campaignHeaders() });
}

async function readJson(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		throw error(400, 'Request body is not valid JSON');
	}
}
