import {
	CAMPAIGN_RATE_LIMIT_POLICIES,
	RateLimitUnavailableError,
	type RateLimitDecision,
	type RateLimitPolicy,
	type SharedRateLimiter
} from './types';

/**
 * Adapter over Cloudflare's rate-limit binding (Increment 5 Task 1 Step 4).
 *
 * IMPORTANT — this is NOT a single global counter. Cloudflare's limits "are
 * local to the Cloudflare location that your Worker runs in", so each key
 * holds a separate counter per colo and a client spread across N locations
 * obtains roughly N times the nominal limit. That is still a large
 * improvement on the per-isolate `Map` in `hooks.server.ts` — it is durable
 * across isolate churn and stops a single abusive or runaway client — but do
 * not describe it as shared/global in comments, runbooks or the completion
 * record. Increment 5 amendment 2 records the trigger at which a Durable
 * Object-backed globally consistent adapter becomes justified; the port
 * exists so that swap needs no caller changes.
 *
 * The binding shape is intentionally re-declared structurally rather than
 * imported from generated Workers types, so this module compiles in the Node
 * test runtime too. `wrangler types` output is the source of truth for the
 * real shape — see the note in `src/app.d.ts`.
 */

export interface CloudflareRateLimitBinding {
	limit(input: { key: string }): Promise<{ success: boolean }>;
}

export type CloudflareRateLimitBindings = Partial<
	Record<RateLimitPolicy, CloudflareRateLimitBinding>
>;

export function createCloudflareRateLimiter(
	bindings: CloudflareRateLimitBindings
): SharedRateLimiter {
	return {
		async check({ key, policy }): Promise<RateLimitDecision> {
			const binding = bindings[policy];
			if (!binding) {
				// Never silently allow. A binding that type-checks and is absent
				// at runtime is exactly the failure mode Increment 5's amendments
				// warn about; surfacing it lets the caller fail closed.
				throw new RateLimitUnavailableError(`No rate-limit binding for policy ${policy}`);
			}

			let outcome: { success: boolean };
			try {
				outcome = await binding.limit({ key });
			} catch (cause) {
				throw new RateLimitUnavailableError(`Rate-limit binding failed for policy ${policy}`, {
					cause
				});
			}

			return outcome.success
				? { allowed: true, retryAfterSeconds: 0 }
				: {
						// The binding reports no reset time, so the policy window is
						// the only honest upper bound we can advertise.
						allowed: false,
						retryAfterSeconds: CAMPAIGN_RATE_LIMIT_POLICIES[policy].periodSeconds
					};
		}
	};
}

/**
 * Name of the dedicated self-test binding, and the limit it is configured
 * with in `wrangler.toml`. Kept deliberately tiny so proving enforcement
 * costs two calls.
 *
 * MUST match `simple.limit` on the `CAMPAIGN_LIMITER_SELFTEST` entry in
 * `wrangler.toml` (both the top level and `[env.staging]`). If they drift the
 * probe reports `not-enforcing` on a healthy binding, which is the safe
 * direction — a false alarm, never a false all-clear.
 */
export const SELF_TEST_BINDING_NAME = 'CAMPAIGN_LIMITER_SELFTEST';
export const SELF_TEST_LIMIT = 1;

export type RateLimitEnforcement = 'enforcing' | 'not-enforcing' | 'unavailable' | 'absent';

/**
 * Actively prove the provider counts, rather than trusting that it exists.
 *
 * A binding that is missing throws, and `campaign.ts` fails mutations closed —
 * that failure mode is loud. The dangerous one is a binding that is present,
 * type-checks, deploys, appears in `wrangler deploy` output as a Rate Limit
 * resource, and silently returns `success: true` forever: it is
 * indistinguishable from "under the limit", so every gate goes green while
 * nothing is enforced. Verified empirically on 2026-07-27 against a throwaway
 * Worker — a 5-per-60s limiter on a fixed key allowed 13 consecutive
 * requests, with no application code involved.
 *
 * So: call the limiter `limit + 1` times against one fixed key. A working
 * limiter must deny at least once. Zero denials means it is not counting.
 *
 * Uses its own binding and its own key, so it never spends a real policy's
 * budget and can never deny a real request.
 */
export async function probeRateLimitEnforcement(
	binding: CloudflareRateLimitBinding | undefined,
	limit: number = SELF_TEST_LIMIT
): Promise<RateLimitEnforcement> {
	if (!binding) return 'absent';

	try {
		for (let attempt = 0; attempt <= limit; attempt++) {
			const { success } = await binding.limit({ key: 'health-self-test' });
			// One denial is proof enough; stop rather than spend the rest.
			if (!success) return 'enforcing';
		}
	} catch {
		return 'unavailable';
	}

	return 'not-enforcing';
}

/**
 * Binding names as declared in `wrangler.toml`. Kept beside the adapter so a
 * rename cannot drift between the config and the lookup.
 */
export const CLOUDFLARE_RATE_LIMIT_BINDING_NAMES: Record<RateLimitPolicy, string> = {
	'session-command': 'CAMPAIGN_SESSION_COMMAND_LIMITER',
	'campaign-mutation': 'CAMPAIGN_MUTATION_LIMITER',
	'join-attempt': 'CAMPAIGN_JOIN_LIMITER',
	'session-poll': 'CAMPAIGN_POLL_LIMITER'
};

/** Collect whichever bindings the platform actually exposes. */
export function readRateLimitBindings(env: Record<string, unknown> | undefined): {
	bindings: CloudflareRateLimitBindings;
	present: RateLimitPolicy[];
} {
	const bindings: CloudflareRateLimitBindings = {};
	const present: RateLimitPolicy[] = [];
	if (!env) return { bindings, present };

	for (const [policy, name] of Object.entries(CLOUDFLARE_RATE_LIMIT_BINDING_NAMES) as [
		RateLimitPolicy,
		string
	][]) {
		const candidate = env[name];
		if (isRateLimitBinding(candidate)) {
			bindings[policy] = candidate;
			present.push(policy);
		}
	}

	return { bindings, present };
}

function isRateLimitBinding(value: unknown): value is CloudflareRateLimitBinding {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as CloudflareRateLimitBinding).limit === 'function'
	);
}
