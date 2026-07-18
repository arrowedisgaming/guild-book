import type { AppDb } from '$lib/server/db';
import { sql, type SQL } from 'drizzle-orm';
import type { CampaignAtomicStatement } from './atomic';

export interface SessionStatePort {
	/** Return the campaign's active-or-frozen session id, or null. */
	activeSessionId(campaignId: string): Promise<string | null>;
	/** SQL guard proving the observed session state still holds at claim time. */
	claimGuard(campaignId: string, activeSessionId: string | null): SQL;
}

/** Increment 2 replaces this with a playSessions query. */
export const noSessionsYet: SessionStatePort = {
	activeSessionId: async () => null,
	claimGuard: () => sql`1 = 1`
};

export interface SessionCleanupInput {
	kind: 'death' | 'leave' | 'remove';
	campaignId: string;
	sessionId: string;
	membershipId: string;
	tenureId: string | null;
	characterId: string | null;
	actorUserId: string;
}

/**
 * Increment 2 supplies statements that mutate session/public/private state.
 * Returning statements, instead of performing side effects here, lets the
 * lifecycle service commit cleanup and access revocation in one transaction.
 */
export interface SessionCleanupPort {
	statements(db: AppDb, input: SessionCleanupInput): Promise<CampaignAtomicStatement[]>;
}
