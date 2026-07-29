import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { campaignHeaders, requireCampaignAccess } from '$lib/server/campaign/access';
import { getDb } from '$lib/server/db';
import { loadTableProjectionsForActor } from '$lib/server/session/table-projections';
import {
	campaignCursor,
	findOpenSessionForCampaign,
	listCampaignEventsSince,
	listEventSecretsForRecipient
} from '$lib/server/session/repository';
import { capEventRows, MAX_EVENTS_PER_RESPONSE, parseNonNegativeIntParam, toWireEvent } from '$lib/server/session/sanitize';
import { hasFreshMatchingCursorHint, recordCursorHint } from '$lib/server/session/latest-cursor';
import { recordCampaignMetric, recordPoll } from '$lib/server/observability/campaign-metrics';

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
	// Increment 5 Task 2: poll latency and the no-change ratio are the two
	// numbers the Task 4 capacity gate is argued from, and neither can be
	// measured anywhere but here — `latest-cursor.ts` sees only the hint hits.
	// Started after authorization so a rejected caller never appears in the
	// latency distribution.
	const startedAt = Date.now();
	const role = await requireCampaignAccess(event, event.params.id);
	const campaignId = event.params.id;

	const after = parseNonNegativeIntParam(event.url.searchParams.get('after'), 'after');
	const clientVersion = parseNonNegativeIntParam(event.url.searchParams.get('version'), 'version');

	// Advisory, isolate-local short-circuit (amendment 6) — only ever
	// consulted AFTER authorization above, and only for an exact, fresh
	// cursor match; anything else falls through to the authoritative reads
	// below. The hint deliberately ignores `clientVersion` — it is only safe
	// under the invariant (documented in `latest-cursor.ts`) that every write
	// which advances a session's version also inserts at least one
	// `campaign_events` row in the same atomic batch, so an unchanged cursor
	// implies an unchanged session version too. If that pairing is ever
	// broken by a future command/lifecycle type, this hint must start
	// tracking version as well or it can mask a real session change.
	if (hasFreshMatchingCursorHint(campaignId, after)) {
		// `hasFreshMatchingCursorHint` already counted the no-change itself.
		recordCampaignMetric({ name: 'poll_duration_ms', value: Date.now() - startedAt, tags: {} });
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
		recordPoll({ durationMs: Date.now() - startedAt, changed: false, outcome: 'authoritative' });
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

	let session:
		| {
				sessionId: string;
				status: string;
				sessionVersion: number;
				campaignCursor: number;
				projection: unknown;
				challengeProjection: unknown;
				challengeLegalCommands: unknown;
				guidedTestProjection: unknown;
				guidedTestLegalCommands: unknown;
				campProjection: unknown;
				campLegalCommands: unknown;
				finiteProjection: unknown;
				finiteLegalCommands: unknown;
		  }
		| null = null;
	if (openSession) {
		// Additive (Increment 3 Task 6): the same actor-scoped generic
		// projection every other route builds, PLUS the Challenge procedure's
		// own projection slice — one combined loader so this route never
		// diverges from `challenge-command-service.ts`'s own builder.
		const {
			projection: projectionEnvelope,
			challengeProjection,
			challengeLegalCommands,
			guidedTestProjection,
			guidedTestLegalCommands,
			campProjection,
			campLegalCommands,
			finiteProjection,
			finiteLegalCommands
		} = await loadTableProjectionsForActor(
			db,
			openSession.sessionId,
			campaignId,
			{ kind: role.kind, userId: role.userId },
			// `currentCursor` was read above, in this same request, to decide
			// whether anything changed at all. Handing it over stops the projection
			// loader re-reading the identical `max(id)`.
			currentCursor
		);
		if (projectionEnvelope) {
			session = {
				sessionId: openSession.sessionId,
				status: openSession.status,
				sessionVersion: projectionEnvelope.sessionVersion,
				campaignCursor: projectionEnvelope.campaignCursor,
				projection: projectionEnvelope.projection,
				challengeProjection,
				challengeLegalCommands,
				guidedTestProjection,
				guidedTestLegalCommands,
				campProjection,
				campLegalCommands,
				finiteProjection,
				finiteLegalCommands
			};
		}
	}

	// Only record the hint when this response reflects the campaign's true
	// current cursor (untruncated) — a truncated batch means the client must
	// poll again before "caught up" can be trusted.
	if (!truncated) recordCursorHint(campaignId, currentCursor);

	recordPoll({ durationMs: Date.now() - startedAt, changed: true });
	return json({ cursor: nextCursor, events, session }, { headers: campaignHeaders() });
};
