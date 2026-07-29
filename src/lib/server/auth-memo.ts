import type { Handle } from '@sveltejs/kit';

/**
 * Memoises `locals.auth()` for the lifetime of one request.
 *
 * `@auth/sveltekit` installs it as a bare function — `event.locals.auth ??= ()
 * => auth(event, _config)` (`dist/index.js`) — not a memoised promise. Every
 * call therefore re-decodes the token and re-runs the `jwt` callback, and this
 * application's `jwt` callback reads the `users` row on every authenticated
 * request to prove the token has not outlived its user (`auth-policy.ts`). The
 * campaign path calls it at least twice — once in `campaignRateLimitHandle`,
 * once in `ensureUser` — so one full D1 round trip per request is spent
 * re-deriving a value that cannot change within that request.
 *
 * That round trip is paid by 100% of campaign requests, including the ~80% of
 * polls that answer `204` and do no other database work at all, at 78–124ms per
 * round trip from a Worker not co-located with the D1 primary. See
 * docs/operations/campaign-capacity.md.
 *
 * **This is not an authorization cache.** It has no TTL and no cross-request
 * storage: it reuses a value already computed inside the same request, and the
 * memo dies with the request. It is specifically NOT "reduction D" (caching a
 * membership/permission decision), which touches authorization and carries
 * staleness risk that this does not.
 *
 * **Why memoising cannot serve a stale session.** The Auth.js handle returns
 * `Auth(request, _config)` directly for its own action routes (sign-in,
 * sign-out, callback) and never calls `resolve` for them. So no request that
 * reaches this handle — which is sequenced after it — can mutate the session
 * mid-flight. Within any request that gets here, the session is a constant.
 *
 * Caches the promise rather than the resolved value, so concurrent callers
 * share one in-flight resolution instead of racing two.
 */
export const memoiseAuthHandle: Handle = async ({ event, resolve }) => {
	const underlying = event.locals.auth;
	// Nothing to wrap during `building`, or if the Auth.js handle has not run.
	if (typeof underlying !== 'function') return resolve(event);

	let cached: ReturnType<typeof underlying> | undefined;
	const memoised = (() => (cached ??= underlying.call(event.locals))) as typeof underlying;

	event.locals.auth = memoised;
	// Auth.js aliases `getSession` to the same resolver; re-point it at the memo
	// so a caller using the alias does not bypass it and pay the round trip.
	if (typeof event.locals.getSession === 'function') {
		event.locals.getSession = memoised as typeof event.locals.getSession;
	}

	return resolve(event);
};
