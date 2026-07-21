import { json, type Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { getDb, getDbContext } from '$lib/server/db';
import { handle as authHandle } from '$lib/server/auth';

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

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_WRITES = 60;
/**
 * The guided Challenge procedure (Increment 3 Task 6) fans out many more,
 * smaller writes per round than any other write path in the app — one
 * `/challenge-commands` POST per seat's Initiative placement, per turn's
 * play/discard/end-turn, and per modifier resolution, from EVERY
 * participant sharing one campaign. A single busy round easily produces a
 * dozen-plus writes, and a table cycling several rounds back-to-back (the
 * deck's own auto-reshuffle, or simply an engaged group) can legitimately
 * exceed the generic 60/60s budget below well within normal play — that
 * budget was sized for the old shared table's coarser, one-action-at-a-time
 * commands. Scoped to ONLY this endpoint family so every other write path
 * keeps the original, tighter abuse-prevention budget unchanged.
 */
const RATE_LIMIT_MAX_WRITES_CHALLENGE_COMMANDS = 300;
const CHALLENGE_COMMANDS_PATH_SEGMENT = '/challenge-commands';
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

	const response = await resolve(event);

	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

	return response;
};

export const handle = devAutoLoginHandle
	? sequence(appHandle, devAutoLoginHandle, authHandle)
	: sequence(appHandle, authHandle);

function isUnsafeRequest(request: Request): boolean {
	return MUTATING_METHODS.has(request.method);
}

function isSameOrigin(request: Request): boolean {
	const origin = request.headers.get('origin');
	if (!origin) return true;

	return origin === new URL(request.url).origin;
}

function isRateLimited(request: Request, clientAddress: string): boolean {
	if (!request.url.includes('/api/') || !isUnsafeRequest(request)) return false;

	const now = Date.now();
	const pathname = new URL(request.url).pathname;
	const key = `${clientAddress}:${pathname}`;
	const bucket = writeBuckets.get(key);

	if (!bucket || bucket.resetAt <= now) {
		if (writeBuckets.size >= RATE_LIMIT_MAX_BUCKETS) pruneExpired(now);
		writeBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
		return false;
	}

	bucket.count += 1;
	const maxWrites = pathname.includes(CHALLENGE_COMMANDS_PATH_SEGMENT) ? RATE_LIMIT_MAX_WRITES_CHALLENGE_COMMANDS : RATE_LIMIT_MAX_WRITES;
	return bucket.count > maxWrites;
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
