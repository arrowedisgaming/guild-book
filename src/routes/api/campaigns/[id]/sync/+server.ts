import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { campaignHeaders, requireCampaignAccess } from '$lib/server/campaign/access';
import { getDb } from '$lib/server/db';
import { loadProjectionForActor } from '$lib/server/session/command-service';
import {
	campaignCursor,
	findOpenSessionForCampaign,
	listCampaignEventsSince,
	listEventSecretsForRecipient
} from '$lib/server/session/repository';
import { capEventRows, MAX_EVENTS_PER_RESPONSE, parseNonNegativeIntParam, toWireEvent } from '$lib/server/session/sanitize';
import { hasFreshMatchingCursorHint, recordCursorHint } from '$lib/server/session/latest-cursor';

const NO_CONTENT_HEADERS = campaignHeaders();

/**
 * Polling endpoint (spec §10.1, controller amendment 1):
 * `GET /api/campaigns/[id]/sync?after=<campaign event cursor>&version=<last-seen session version>`.
 * `204` when nothing has changed since `after`/`version`; otherwise the next
 * cursor, up to `MAX_EVENTS_PER_RESPONSE` role-projected events, and the
 * open session's fresh actor projection (or `null` once no session is
 * open). Never reads or returns a secret the caller doesn't own — events
 * only ever carry the authenticated recipient's own `privatePayload`
 * (`sanitize.ts`'s `toWireEvent`), and the session projection comes from the
 * same actor-scoped builder every other session route uses.
 */
export const GET: RequestHandler = async (event) => {
	const role = await requireCampaignAccess(event, event.params.id);
	const campaignId = event.params.id;

	const after = parseNonNegativeIntParam(event.url.searchParams.get('after'), 'after');
	const clientVersion = parseNonNegativeIntParam(event.url.searchParams.get('version'), 'version');

	// Advisory, isolate-local short-circuit (amendment 6) — only ever
	// consulted AFTER authorization above, and only for an exact, fresh
	// cursor match; anything else falls through to the authoritative reads
	// below.
	if (hasFreshMatchingCursorHint(campaignId, after)) {
		return new Response(null, { status: 204, headers: NO_CONTENT_HEADERS });
	}

	const db = await getDb(event);
	const [currentCursor, openSession] = await Promise.all([
		campaignCursor(db, campaignId),
		findOpenSessionForCampaign(db, campaignId)
	]);

	const sessionVersionChanged = openSession !== null && openSession.version !== clientVersion;
	if (currentCursor === after && !sessionVersionChanged) {
		recordCursorHint(campaignId, currentCursor);
		return new Response(null, { status: 204, headers: NO_CONTENT_HEADERS });
	}

	const rows = await listCampaignEventsSince(db, campaignId, after, MAX_EVENTS_PER_RESPONSE + 1);
	const { rows: cappedRows, truncated } = capEventRows(rows);
	const secretsByEventId = await listEventSecretsForRecipient(
		db,
		cappedRows.map((row) => row.id),
		role.userId
	);
	const events = cappedRows.map((row) => toWireEvent(row, secretsByEventId));
	const nextCursor = events.length > 0 ? events[events.length - 1].id : currentCursor;

	let session: { sessionId: string; status: string; sessionVersion: number; campaignCursor: number; projection: unknown } | null =
		null;
	if (openSession) {
		const projectionEnvelope = await loadProjectionForActor(db, openSession.sessionId, campaignId, {
			kind: role.kind,
			userId: role.userId
		});
		if (projectionEnvelope) {
			session = {
				sessionId: openSession.sessionId,
				status: openSession.status,
				sessionVersion: projectionEnvelope.sessionVersion,
				campaignCursor: projectionEnvelope.campaignCursor,
				projection: projectionEnvelope.projection
			};
		}
	}

	// Only record the hint when this response reflects the campaign's true
	// current cursor (untruncated) — a truncated batch means the client must
	// poll again before "caught up" can be trusted.
	if (!truncated) recordCursorHint(campaignId, currentCursor);

	return json({ cursor: nextCursor, events, session }, { headers: campaignHeaders() });
};
