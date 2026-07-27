// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { DefaultSession } from '@auth/core/types';
import type { AppDb, AppDbContext } from '$lib/server/db';

declare module '@auth/core/types' {
	interface Session {
		user?: {
			id?: string;
		} & DefaultSession['user'];
	}
}

declare global {
	const __APP_VERSION__: string;

	namespace App {
		// interface Error {}
		interface Locals {
			db: AppDb;
			dbContext: AppDbContext;
		}
		// interface PageData {}
		// interface PageState {}
		interface Platform {
			env: {
				DB?: D1Database;
				CAMPAIGNS_ENABLED?: string;
				CAMPAIGNS_PILOT_USER_IDS?: string;
				CAMPAIGN_INVITE_SECRET?: string;
				/**
				 * Campaign rate-limit bindings, declared as `[[ratelimits]]` in
				 * `wrangler.toml`. `RateLimit` comes from
				 * `@cloudflare/workers-types` (already in tsconfig `types`) and is
				 * byte-identical to what `npx wrangler types` generates for these
				 * four bindings — verified 2026-07-27 against workerd
				 * 1.20260630.1. The generated `worker-configuration.d.ts` is not
				 * committed because this repository consumes the published types
				 * package instead; re-run `npx wrangler types` and diff against
				 * this block if the binding shape ever changes.
				 *
				 * Optional on purpose: they are absent off the edge, and
				 * `rate-limit/campaign.ts` decides what that means per policy.
				 */
				CAMPAIGN_SESSION_COMMAND_LIMITER?: RateLimit;
				CAMPAIGN_MUTATION_LIMITER?: RateLimit;
				CAMPAIGN_JOIN_LIMITER?: RateLimit;
				CAMPAIGN_POLL_LIMITER?: RateLimit;
			};
		}
	}
}

export {};
