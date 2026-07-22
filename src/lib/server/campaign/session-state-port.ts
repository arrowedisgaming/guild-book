import type { AppDb } from '$lib/server/db';
import { sql, type SQL } from 'drizzle-orm';
import type { CampaignAtomicStatement } from './atomic';

export interface SessionStatePort {
	/** Return the campaign's active-or-frozen session id, or null. */
	activeSessionId(campaignId: string): Promise<string | null>;
	/** SQL guard proving the observed session state still holds at claim time. */
	claimGuard(campaignId: string, activeSessionId: string | null): SQL;
}

/**
 * Thrown by a `BuildChallengeJoinStatements` callback when it cannot determine
 * whether to register a pending Challenge join because the open session is not
 * `active` (e.g. frozen). `attachAdventurer` catches this specific type and
 * returns a typed `'session-not-active'` result instead of letting it surface
 * as a 500 (branch-fix I3 / ledger O11 item 1). Lives in this leaf module so
 * both `tenure.ts` (the catcher) and `command-service.ts` (the thrower) can
 * import it without a circular dependency.
 */
export class ChallengeJoinSessionNotActiveError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ChallengeJoinSessionNotActiveError';
	}
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
