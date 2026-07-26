/**
 * Completed-session history (Increment 4 Task 5) — the sanitized read side.
 *
 * History is a PROJECTION of what `endSession` already persisted: the ordered
 * public event log and the stamped final public state. Nothing here re-reads
 * fragments (they were purged at end), so nothing here CAN leak a private
 * hand, a prepared card, a server draw order, or a recipient secret — the
 * rows that held them no longer exist. Completed public history never reveals
 * cards that stayed private when the session ended, by construction.
 *
 * Access: the GM and every CURRENT member. Former, removed, and non-members
 * get `null`, which the routes render as 404 — membership is checked here so
 * no caller can forget it, and responses are served `private, no-store`.
 *
 * The checksum is corruption DETECTION only, never a signature: it proves the
 * ordered public history a client sees matches what was stamped at end, not
 * that a hostile database could not have restamped both.
 */

import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import type { AppDb } from '$lib/server/db';
import { campaignEvents, campaignMembers, campaigns, playSessions } from '$lib/server/db/schema';

export interface CompletedSessionSummary {
	sessionId: string;
	sequence: number;
	endedAt: Date;
	publicHistoryChecksum: string | null;
}

export interface CompletedSessionHistory {
	sessionId: string;
	sequence: number;
	endedAt: Date;
	publicHistoryChecksum: string | null;
	/** The GM-visible PUBLIC projection stamped at end — already sanitized by
	 * the projector: counts and card backs for private zones, never faces. */
	finalPublicState: unknown;
	/** Ordered public event log. `publicPayload` only — the per-recipient
	 * secret rows were deleted at end. */
	publicEvents: Array<{ id: number; kind: string; publicPayload: unknown }>;
}

/** True when `userId` is the campaign owner or a current member. */
async function isCurrentMember(db: AppDb, campaignId: string, userId: string): Promise<boolean> {
	const campaign = await db
		.select({ ownerUserId: campaigns.ownerUserId })
		.from(campaigns)
		.where(eq(campaigns.id, campaignId))
		.get();
	if (!campaign) return false;
	if (campaign.ownerUserId === userId) return true;
	// `leftAt`/`removedAt` are the soft-departure markers: a row survives after a
	// member leaves or is removed, so matching on campaign+user alone would keep
	// serving history to a FORMER member (review finding — the page loaders' own
	// access check masked it, but this service is exported and documents itself
	// as the gate).
	const membership = await db
		.select({ id: campaignMembers.id })
		.from(campaignMembers)
		.where(
			and(
				eq(campaignMembers.campaignId, campaignId),
				eq(campaignMembers.userId, userId),
				isNull(campaignMembers.leftAt),
				isNull(campaignMembers.removedAt)
			)
		)
		.get();
	return membership !== undefined;
}

/** Every ended session in the campaign, newest first. `null` when the caller
 * is not a current member — routes must render that as 404. */
export async function listCompletedSessions(
	db: AppDb,
	campaignId: string,
	viewerUserId: string
): Promise<CompletedSessionSummary[] | null> {
	if (!(await isCurrentMember(db, campaignId, viewerUserId))) return null;

	const rows = await db
		.select({
			sessionId: playSessions.id,
			sequence: playSessions.sequence,
			endedAt: playSessions.endedAt,
			publicHistoryChecksum: playSessions.publicHistoryChecksum
		})
		.from(playSessions)
		.where(and(eq(playSessions.campaignId, campaignId), eq(playSessions.status, 'ended'), isNotNull(playSessions.endedAt)))
		.orderBy(desc(playSessions.endedAt));

	return rows.map((row) => ({
		sessionId: row.sessionId,
		sequence: row.sequence,
		endedAt: row.endedAt as Date,
		publicHistoryChecksum: row.publicHistoryChecksum
	}));
}

/**
 * One completed session's full public history. `null` for a non-member, a
 * session outside `campaignId`, or a session that has not ended — all
 * deliberately indistinguishable, so this never confirms the existence of a
 * session the caller may not see.
 */
export async function loadCompletedSessionHistory(
	db: AppDb,
	campaignId: string,
	sessionId: string,
	viewerUserId: string
): Promise<CompletedSessionHistory | null> {
	if (!(await isCurrentMember(db, campaignId, viewerUserId))) return null;

	const session = await db
		.select({
			campaignId: playSessions.campaignId,
			sequence: playSessions.sequence,
			status: playSessions.status,
			endedAt: playSessions.endedAt,
			finalPublicStateJson: playSessions.finalPublicStateJson,
			publicHistoryChecksum: playSessions.publicHistoryChecksum
		})
		.from(playSessions)
		.where(eq(playSessions.id, sessionId))
		.get();
	if (!session || session.campaignId !== campaignId || session.status !== 'ended' || !session.endedAt) return null;

	const eventRows = await db
		.select({ id: campaignEvents.id, kind: campaignEvents.kind, publicPayloadJson: campaignEvents.publicPayloadJson })
		.from(campaignEvents)
		.where(eq(campaignEvents.sessionId, sessionId));

	return {
		sessionId,
		sequence: session.sequence,
		endedAt: session.endedAt,
		publicHistoryChecksum: session.publicHistoryChecksum,
		finalPublicState: session.finalPublicStateJson ? (JSON.parse(session.finalPublicStateJson) as unknown) : null,
		publicEvents: eventRows
			.slice()
			.sort((a, b) => a.id - b.id)
			.map((row) => ({ id: row.id, kind: row.kind, publicPayload: JSON.parse(row.publicPayloadJson) as unknown }))
	};
}
