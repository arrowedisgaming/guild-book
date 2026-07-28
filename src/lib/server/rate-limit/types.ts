/**
 * Provider-neutral shared rate-limit port (Increment 5 Task 1).
 *
 * The production adapter is Cloudflare's rate-limit binding, but the port
 * exists so that adapter is swappable. Read the caveat in `cloudflare.ts`
 * before describing this as a global limiter anywhere — it is not.
 */

export type RateLimitPolicy =
	| 'session-command'
	| 'campaign-mutation'
	| 'join-attempt'
	| 'session-poll';

export interface RateLimitDecision {
	allowed: boolean;
	retryAfterSeconds: number;
}

export interface SharedRateLimiter {
	check(input: { key: string; policy: RateLimitPolicy }): Promise<RateLimitDecision>;
}

/**
 * Raised when the provider could not answer at all — a missing binding, or a
 * call that threw. Distinct from a denial: a denial is the limiter working,
 * this is the limiter absent. `campaign.ts` resolves the two differently
 * (mutations fail closed, polls degrade open).
 */
export class RateLimitUnavailableError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'RateLimitUnavailableError';
	}
}

export interface RateLimitPolicyDefinition {
	/** Requests permitted per bucket per window. */
	limit: number;
	/**
	 * Cloudflare's `[ratelimits.simple]` accepts exactly 10 or 60 seconds and
	 * nothing else (Increment 5 amendment 3), so the port deliberately cannot
	 * express an arbitrary window the production provider could not honour.
	 */
	periodSeconds: 10 | 60;
	/**
	 * Mutations fail closed when the provider is unavailable; reads degrade
	 * open. Polling GETs are unlimited today (amendment 4), so there is no
	 * prior behaviour a failed-closed poll could degrade to — refusing them
	 * during a limiter outage would take working tables down.
	 */
	kind: 'mutation' | 'read';
}

/**
 * Lives here rather than in `campaign.ts` because both adapters need it and
 * `campaign.ts` imports both — putting it there would make the cycle.
 *
 * `session-command` is the loosest budget on purpose: one guided Challenge
 * round issues an Initiative placement, play/discard/end-turn and modifier
 * resolution per seat, from every participant at the table, which is the same
 * reason `hooks.server.ts` already carves out 300/60s for that route family.
 * Sizing it lower would show up as rate-limit false positives in the Task 4
 * capacity run rather than as abuse prevention.
 */
export const CAMPAIGN_RATE_LIMIT_POLICIES: Record<RateLimitPolicy, RateLimitPolicyDefinition> = {
	'session-command': { limit: 300, periodSeconds: 60, kind: 'mutation' },
	'campaign-mutation': { limit: 60, periodSeconds: 60, kind: 'mutation' },
	'join-attempt': { limit: 10, periodSeconds: 60, kind: 'mutation' },
	// ~1s poll cadence per open table; 3/s absorbs reconnect waves and the
	// foreground/background transitions Task 4 Step 1 exercises.
	'session-poll': { limit: 30, periodSeconds: 10, kind: 'read' }
};
