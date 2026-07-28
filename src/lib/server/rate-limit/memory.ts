import {
	CAMPAIGN_RATE_LIMIT_POLICIES,
	type RateLimitDecision,
	type RateLimitPolicy,
	type SharedRateLimiter
} from './types';

/**
 * Fixed-window in-memory limiter. Development and test defence ONLY — it is
 * per-isolate, so on Cloudflare it resets with every isolate and provides no
 * production guarantee. `campaign.ts` only selects it off the edge.
 *
 * The clock is injectable so window expiry is exercised deterministically
 * rather than with real sleeps.
 */

const MAX_BUCKETS = 4096;
const PRUNE_HEADROOM = 64;

export interface MemoryRateLimiterOptions {
	now?: () => number;
}

export function createMemoryRateLimiter(options: MemoryRateLimiterOptions = {}): SharedRateLimiter {
	const now = options.now ?? (() => Date.now());
	const buckets = new Map<string, { count: number; resetAt: number }>();

	return {
		async check({ key, policy }: { key: string; policy: RateLimitPolicy }): Promise<RateLimitDecision> {
			const { limit, periodSeconds } = CAMPAIGN_RATE_LIMIT_POLICIES[policy];
			const at = now();
			const bucket = buckets.get(key);

			if (!bucket || bucket.resetAt <= at) {
				if (buckets.size >= MAX_BUCKETS) prune(buckets, at);
				buckets.set(key, { count: 1, resetAt: at + periodSeconds * 1000 });
				return { allowed: true, retryAfterSeconds: 0 };
			}

			bucket.count += 1;
			if (bucket.count <= limit) return { allowed: true, retryAfterSeconds: 0 };

			return {
				allowed: false,
				// Round up: a client told to retry in 0 seconds retries immediately
				// and is denied again, which reads as a broken endpoint.
				retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - at) / 1000))
			};
		}
	};
}

function prune(buckets: Map<string, { count: number; resetAt: number }>, at: number): void {
	for (const [key, bucket] of buckets) {
		if (bucket.resetAt <= at) buckets.delete(key);
	}
	// Still oversized: drop the longest-lived entries first. Map iteration is
	// insertion-ordered, so those come first.
	if (buckets.size >= MAX_BUCKETS) {
		const overshoot = buckets.size - MAX_BUCKETS + PRUNE_HEADROOM;
		const keys = buckets.keys();
		for (let i = 0; i < overshoot; i++) {
			const next = keys.next();
			if (next.done) break;
			buckets.delete(next.value);
		}
	}
}
