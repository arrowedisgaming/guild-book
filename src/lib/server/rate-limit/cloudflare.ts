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
