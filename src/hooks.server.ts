import { json, type Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { getDb, getDbContext } from '$lib/server/db';
import { handle as authHandle, getEnv, getUserId } from '$lib/server/auth';
import { memoiseAuthHandle } from '$lib/server/auth-memo';
import {
	classifyCampaignRequest,
	createCampaignRateLimitHandle
} from '$lib/server/rate-limit/campaign';
import { formatServerTiming, runWithRequestTiming } from '$lib/server/observability/request-timing';
import { installCampaignMetricSink } from '$lib/server/observability/metric-sink';

// Optional dev-only auto-login bypass. The implementation file is gitignored
// (see src/lib/server/dev-auto-login.example.ts). When absent — production,
// fresh clones, CI — the glob map is empty and we fall back to a no-op.
const devAutoLoginModules = import.meta.glob<{ devAutoLoginHandle?: Handle }>(
	'./lib/server/dev-auto-login.ts'
);
const devAutoLoginLoader = devAutoLoginModules['./lib/server/dev-auto-login.ts'];
let devAutoLoginHandle: Handle | null = null;
if (devAutoLoginLoader) {
	try {
		const mod = await devAutoLoginLoader();
		devAutoLoginHandle = mod.devAutoLoginHandle ?? null;
	} catch (err) {
		console.warn('[dev-auto-login] failed to load:', (err as Error)?.message ?? err);
	}
}

// Once per isolate. Without this every campaign metric is computed and then
// dropped — see `metric-sink.ts` for why that went unnoticed until 0.7.0.
installCampaignMetricSink();

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_WRITES = 60;
const writeBuckets = new Map<string, { count: number; resetAt: number }>();
// On a long-lived Node process, distinct path keys accumulate forever otherwise.
const RATE_LIMIT_MAX_BUCKETS = 4096;

const appHandle: Handle = async ({ event, resolve }) => {
	event.locals.dbContext = await getDbContext(event);
	event.locals.db = await getDb(event);

	if (isUnsafeRequest(event.request) && !isSameOrigin(event.request)) {
		return json({ message: 'Invalid request origin' }, { status: 403 });
	}

	if (isRateLimited(event.request, event.getClientAddress())) {
		return json({ message: 'Too many requests' }, { status: 429 });
	}

	// Everything downstream — the rest of the `handle` sequence and the route
	// handler — runs inside one timing scope, so every D1 round trip it makes is
	// attributed to this request. `startedAt` is taken here rather than at the
	// top of the function so the two cheap synchronous guards above, which issue
	// no I/O, are not counted as server time.
	const startedAt = Date.now();
	const { response, timing } = await runWithRequestTiming(async (scope) => ({
		response: await resolve(event),
		timing: scope
	}));
	const serverMs = Date.now() - startedAt;

	if (timingHeaderEnabled(event)) {
		response.headers.set('Server-Timing', formatServerTiming({ serverMs, timing }));
		const colo = event.platform?.cf?.colo;
		// Which colo served the run is the one geographic fact the capacity gate
		// cannot obtain from the client side, and the 2026-07-28 runs turned on
		// exactly that question. Server-side infrastructure detail, not user data.
		if (typeof colo === 'string' && colo.length > 0) response.headers.set('X-Guildbook-Colo', colo);
	}

	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

	return response;
};

/**
 * Sequenced AFTER `authHandle` on purpose (Increment 5 Task 1): the campaign
 * limiter keys its buckets on the authenticated actor, which only exists once
 * auth has installed `locals.auth()`. It runs before every route handler, so a
 * limited request never reaches the session state reconstruction it was trying
 * to spend.
 *
 * It does NOT make a denial free. Resolving the actor calls `locals.auth()`,
 * whose `jwt` callback reads the `users` row, so a denied request from a
 * SIGNED-IN caller has already paid one D1 round trip by the time it is
 * refused — an authenticated flood keeps costing database capacity after it
 * starts receiving 429s. (An anonymous flood does not: with no session cookie
 * there is no row to read.) This comment previously claimed the opposite; the
 * 0.7.0 pre-release review caught it.
 *
 * Keying on the signed JWT subject instead would let a denial land before any
 * database work, but it means a second cookie/secret/session-version decode
 * path parallel to Auth.js's, which is a change that wants its own review
 * rather than a release-day patch. Tracked rather than done here.
 */
const campaignRateLimitHandle = createCampaignRateLimitHandle({ getUserId, getEnv });

/**
 * Sequenced immediately AFTER `authHandle` and BEFORE every consumer, which is
 * the only position that works: `authHandle` installs `locals.auth`, and
 * `campaignRateLimitHandle` is the first thing to call it. Memoising there
 * saves one D1 round trip on every campaign request — see `auth-memo.ts`.
 */
export const handle = devAutoLoginHandle
	? sequence(appHandle, devAutoLoginHandle, authHandle, memoiseAuthHandle, campaignRateLimitHandle)
	: sequence(appHandle, authHandle, memoiseAuthHandle, campaignRateLimitHandle);

/**
 * `Server-Timing` is opt-in, and off unless `CAMPAIGN_TIMING_HEADER` is
 * explicitly `true`/`1` (Increment 5 Task 4 follow-up).
 *
 * On by default would publish the application's internal I/O timings to every
 * client on every response — a mild timing side channel with no upside outside
 * a measured run. Staging sets it in `[env.staging.vars]`; production does not.
 * `tests/load/session-polling.mjs` sets it in the environment of the preview
 * server it boots, so a local run exercises the same path without a deploy;
 * an ordinary `npm run dev` leaves it unset.
 *
 * Fails closed: an unset, misspelt or unparsed value means no header, which the
 * harness reports as missing coverage rather than as a zero.
 */
function timingHeaderEnabled(event: Parameters<Handle>[0]['event']): boolean {
	const raw = getEnv(event, 'CAMPAIGN_TIMING_HEADER');
	return raw === 'true' || raw === '1';
}

function isUnsafeRequest(request: Request): boolean {
	return MUTATING_METHODS.has(request.method);
}

function isSameOrigin(request: Request): boolean {
	const origin = request.headers.get('origin');
	if (!origin) return true;

	return origin === new URL(request.url).origin;
}

/**
 * Process-local write limiter for the NON-campaign API. Development defence
 * only: the `Map` lives in one isolate, so on Cloudflare it resets with every
 * isolate and enforces nothing durable.
 *
 * Campaign traffic is deliberately excluded (Increment 5 Task 1 Step 5) — it
 * is handled by `campaignRateLimitHandle`, which is backed by the edge
 * binding in production and by its own injectable-clock in-memory limiter
 * elsewhere. Double-limiting the same request would make the effective budget
 * the tighter of the two and produce false positives in the Task 4 capacity
 * run. The 300/60s allowance the guided Challenge command routes used to get
 * here now lives in `CAMPAIGN_RATE_LIMIT_POLICIES['session-command']`.
 */
function isRateLimited(request: Request, clientAddress: string): boolean {
	if (!request.url.includes('/api/') || !isUnsafeRequest(request)) return false;

	const now = Date.now();
	const pathname = new URL(request.url).pathname;
	if (classifyCampaignRequest(pathname, request.method)) return false;

	const key = `${clientAddress}:${pathname}`;
	const bucket = writeBuckets.get(key);

	if (!bucket || bucket.resetAt <= now) {
		if (writeBuckets.size >= RATE_LIMIT_MAX_BUCKETS) pruneExpired(now);
		writeBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
		return false;
	}

	bucket.count += 1;
	return bucket.count > RATE_LIMIT_MAX_WRITES;
}

function pruneExpired(now: number): void {
	for (const [k, b] of writeBuckets) {
		if (b.resetAt <= now) writeBuckets.delete(k);
	}
	// If still oversized after pruning expired entries, drop oldest reset-window
	// entries first. Map iteration is insertion-ordered, so the first entries
	// are the longest-lived.
	if (writeBuckets.size >= RATE_LIMIT_MAX_BUCKETS) {
		const overshoot = writeBuckets.size - RATE_LIMIT_MAX_BUCKETS + 64;
		const iter = writeBuckets.keys();
		for (let i = 0; i < overshoot; i++) {
			const next = iter.next();
			if (next.done) break;
			writeBuckets.delete(next.value);
		}
	}
}
