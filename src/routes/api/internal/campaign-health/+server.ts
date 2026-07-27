import { createHash, timingSafeEqual } from 'node:crypto';
import { error, json } from '@sveltejs/kit';
import { and, count, eq, sql } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { getEnv } from '$lib/server/auth';
import { getCampaignFeatureConfig } from '$lib/server/campaign/config';
import { compileSessionRuntimeContent } from '$lib/server/content/session-runtime';
import { getContentPack, getTarotProcedures } from '$lib/server/content/loader';
import { getDb } from '$lib/server/db';
import { campaignEvents, playSessions } from '$lib/server/db/schema';
import { privateHeaders } from '$lib/server/http';
import { readDegradedPollCount } from '$lib/server/rate-limit/campaign';
import { CLOUDFLARE_RATE_LIMIT_BINDING_NAMES } from '$lib/server/rate-limit/cloudflare';

/**
 * Internal operations health check (Increment 5 Task 2 Step 3).
 *
 * AGGREGATE DATA ONLY. Every field here is a boolean, a count, a duration, or
 * a deployment identifier that is already public in the built artifact. No
 * campaign id, session id, user id, invite token, card identity or session
 * payload may ever be added to this response — it is the one campaign
 * endpoint whose caller is not a campaign participant.
 *
 * Disabled entirely when `CAMPAIGN_HEALTH_SECRET` is unset, and every denial
 * is a 404 rather than a 401 so the endpoint's existence is not advertised to
 * an unauthenticated prober — the same stance `campaign/access.ts` takes.
 */
export const GET: RequestHandler = async (event) => {
	const secret = getEnv(event, 'CAMPAIGN_HEALTH_SECRET');
	if (!secret) throw notFound();

	const presented = bearerToken(event.request);
	if (!presented || !constantTimeEquals(presented, secret)) throw notFound();

	const feature = getCampaignFeatureConfig(event);
	const platformEnv = event.platform?.env as Record<string, unknown> | undefined;

	const bindingsPresent: string[] = [];
	const bindingsMissing: string[] = [];
	for (const name of Object.values(CLOUDFLARE_RATE_LIMIT_BINDING_NAMES)) {
		const candidate = platformEnv?.[name] as { limit?: unknown } | undefined;
		(typeof candidate?.limit === 'function' ? bindingsPresent : bindingsMissing).push(name);
	}

	const database = await readDatabaseHealth(event);
	const content = readContentDigest();

	return json(
		{
			campaignsEnabled: feature.enabled,
			// The size, never the ids — the allowlist is a list of real users.
			pilotAllowlistSize: feature.pilotUserIds.size,
			rateLimit: {
				bindingsPresent,
				bindingsMissing,
				degradedPolls: readDegradedPollCount()
			},
			database,
			content
		},
		{ headers: privateHeaders() }
	);
};

interface DatabaseHealth {
	reachable: boolean;
	migrationsApplied: number | null;
	activeSessions: number | null;
	frozenSessions: number | null;
	oldestFrozenAgeSeconds: number | null;
}

async function readDatabaseHealth(event: Parameters<RequestHandler>[0]): Promise<DatabaseHealth> {
	const unreachable: DatabaseHealth = {
		reachable: false,
		migrationsApplied: null,
		activeSessions: null,
		frozenSessions: null,
		oldestFrozenAgeSeconds: null
	};

	try {
		const db = await getDb(event);

		const [active, frozen] = await Promise.all([
			db.select({ value: count() }).from(playSessions).where(eq(playSessions.status, 'active')).get(),
			db.select({ value: count() }).from(playSessions).where(eq(playSessions.status, 'frozen')).get()
		]);

		return {
			reachable: true,
			migrationsApplied: await readMigrationsApplied(db),
			activeSessions: active?.value ?? 0,
			frozenSessions: frozen?.value ?? 0,
			oldestFrozenAgeSeconds: await readOldestFrozenAgeSeconds(db)
		};
	} catch {
		// Never surface the driver error: it can carry a connection string or a
		// statement fragment. Reachability is the signal; the logs are where an
		// operator goes for the cause.
		return unreachable;
	}
}

/**
 * Migration presence, tolerant of both tracking tables: `drizzle-kit push`
 * writes `__drizzle_migrations` locally, while `wrangler d1 migrations apply`
 * writes `d1_migrations`. A deployment missing both has never been migrated,
 * which is exactly what this field exists to catch.
 */
async function readMigrationsApplied(db: Awaited<ReturnType<typeof getDb>>): Promise<number | null> {
	for (const table of ['d1_migrations', '__drizzle_migrations']) {
		try {
			const row = await db.get<{ value: number }>(
				sql`select count(*) as value from ${sql.identifier(table)}`
			);
			if (row && typeof row.value === 'number') return row.value;
		} catch {
			// Table absent on this driver — try the next candidate.
		}
	}
	return null;
}

/**
 * How long the longest-stuck session has been frozen, from the most recent
 * `session-frozen` event of each session that is *currently* frozen. Using
 * the most recent freeze per session matters: a session that froze, was
 * recovered, and froze again has only been stuck since the second freeze.
 */
async function readOldestFrozenAgeSeconds(
	db: Awaited<ReturnType<typeof getDb>>
): Promise<number | null> {
	const row = await db
		.select({
			oldest: sql<number | null>`min(${campaignEvents.createdAt})`
		})
		.from(playSessions)
		.innerJoin(
			campaignEvents,
			and(eq(campaignEvents.sessionId, playSessions.id), eq(campaignEvents.kind, 'session-frozen'))
		)
		.where(
			and(
				eq(playSessions.status, 'frozen'),
				// Most recent freeze for this session only.
				sql`${campaignEvents.createdAt} = (
					select max(inner_events.created_at) from campaign_events as inner_events
					where inner_events.session_id = ${playSessions.id}
					and inner_events.kind = 'session-frozen'
				)`
			)
		)
		.get();

	const oldest = row?.oldest;
	if (oldest === null || oldest === undefined) return null;

	// Stored as a unix-seconds integer by the timestamp mode; guard against a
	// clock skew producing a negative age.
	const ageSeconds = Math.floor(Date.now() / 1000) - Number(oldest);
	return Number.isFinite(ageSeconds) ? Math.max(0, ageSeconds) : null;
}

function readContentDigest(): { packId: string; packVersion: string; runtimeDigest: string } {
	const runtime = compileSessionRuntimeContent({
		pack: getContentPack(),
		proceduresFile: getTarotProcedures()
	});
	return {
		packId: runtime.contentPackId,
		packVersion: runtime.contentPackVersion,
		runtimeDigest: runtime.contentDigest
	};
}

function bearerToken(request: Request): string | null {
	const header = request.headers.get('authorization');
	if (!header) return null;
	const [scheme, ...rest] = header.split(' ');
	if (scheme.toLowerCase() !== 'bearer') return null;
	const token = rest.join(' ').trim();
	return token.length > 0 ? token : null;
}

/**
 * Hash both sides before comparing so `timingSafeEqual` always receives equal
 * lengths — comparing raw buffers would throw on a length mismatch, and the
 * throw itself would leak the secret's length.
 */
function constantTimeEquals(presented: string, expected: string): boolean {
	const a = createHash('sha256').update(presented).digest();
	const b = createHash('sha256').update(expected).digest();
	return timingSafeEqual(a, b);
}

function notFound() {
	return error(404, 'Not found');
}
