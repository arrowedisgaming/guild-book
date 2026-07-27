import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyMigrations, makeDbContext, seedCampaignFoundation } from '../fixtures/session-http';
import type { AppDbContext } from '$lib/server/db/atomic';

/**
 * Increment 5 Task 2 Step 3 — the internal health endpoint. Asserts the
 * endpoint is invisible without its secret, that the comparison is against
 * the whole secret rather than a prefix, and above all that the payload is
 * aggregate only: no campaign, session, user or invite identifier may appear
 * anywhere in the serialized response.
 */

const HEALTH_SECRET = 'health-secret-value';
const CAMPAIGN_ID = 'campaign-a';
const GM_USER_ID = 'gm-a';
const INVITE_CANARY = 'INVITE_TOKEN_CANARY';

interface HealthBody {
	campaignsEnabled: boolean;
	pilotAllowlistSize: number;
	rateLimit: { bindingsPresent: string[]; bindingsMissing: string[]; degradedPolls: number };
	database: {
		reachable: boolean;
		migrationsApplied: number | null;
		activeSessions: number | null;
		frozenSessions: number | null;
		oldestFrozenAgeSeconds: number | null;
	};
	content: { packId: string; packVersion: string; runtimeDigest: string };
}

const mocks = vi.hoisted(() => ({
	getEnv: vi.fn(),
	getDb: vi.fn()
}));

vi.mock('$lib/server/auth', () => ({ getEnv: mocks.getEnv, ensureUser: vi.fn() }));
vi.mock('$lib/server/db', () => ({ getDb: mocks.getDb }));

import { GET as getHealth } from '../../src/routes/api/internal/campaign-health/+server';

interface HealthEventOptions {
	authorization?: string;
	env?: Record<string, string>;
	platformEnv?: Record<string, unknown>;
}

function healthEvent(options: HealthEventOptions = {}) {
	const env: Record<string, string> = {
		CAMPAIGN_HEALTH_SECRET: HEALTH_SECRET,
		CAMPAIGNS_ENABLED: 'true',
		CAMPAIGNS_PILOT_USER_IDS: `${GM_USER_ID},player-a`,
		CAMPAIGN_INVITE_SECRET: INVITE_CANARY,
		...options.env
	};
	mocks.getEnv.mockImplementation((_event: unknown, key: string) => env[key]);

	return {
		url: new URL('http://localhost/api/internal/campaign-health'),
		request: new Request('http://localhost/api/internal/campaign-health', {
			headers: options.authorization ? { authorization: options.authorization } : {}
		}),
		platform: options.platformEnv ? { env: options.platformEnv } : undefined,
		locals: {},
		setHeaders: () => {}
	};
}

async function status(event: ReturnType<typeof healthEvent>): Promise<number> {
	try {
		const response = await getHealth(event as never);
		return response.status;
	} catch (cause) {
		return (cause as { status?: number }).status ?? 500;
	}
}

describe('internal campaign health', () => {
	let sqlite: Database.Database;
	let dbContext: AppDbContext;

	beforeEach(() => {
		vi.clearAllMocks();
		sqlite = new Database(':memory:');
		sqlite.pragma('foreign_keys = ON');
		applyMigrations(sqlite);
		seedCampaignFoundation(sqlite, { campaignId: CAMPAIGN_ID, gmUserId: GM_USER_ID });
		dbContext = makeDbContext(sqlite);
		mocks.getDb.mockResolvedValue(dbContext.db);
	});

	afterEach(() => sqlite.close());

	describe('authentication', () => {
		it('is entirely absent when no secret is configured', async () => {
			expect(
				await status(
					healthEvent({
						authorization: `Bearer ${HEALTH_SECRET}`,
						env: { CAMPAIGN_HEALTH_SECRET: '' }
					})
				)
			).toBe(404);
		});

		it('answers 404, not 401, to an unauthenticated caller', async () => {
			expect(await status(healthEvent())).toBe(404);
		});

		it('rejects a wrong secret, a prefix of it, and a non-bearer scheme', async () => {
			expect(await status(healthEvent({ authorization: 'Bearer wrong' }))).toBe(404);
			expect(
				await status(healthEvent({ authorization: `Bearer ${HEALTH_SECRET.slice(0, 8)}` }))
			).toBe(404);
			expect(await status(healthEvent({ authorization: `Basic ${HEALTH_SECRET}` }))).toBe(404);
			expect(await status(healthEvent({ authorization: 'Bearer ' }))).toBe(404);
		});

		it('accepts the exact secret', async () => {
			expect(await status(healthEvent({ authorization: `Bearer ${HEALTH_SECRET}` }))).toBe(200);
		});
	});

	describe('payload', () => {
		async function body(options: HealthEventOptions = {}) {
			const response = await getHealth(
				healthEvent({ authorization: `Bearer ${HEALTH_SECRET}`, ...options }) as never
			);
			expect(response.status).toBe(200);
			return {
				json: (await response.clone().json()) as HealthBody,
				text: await response.text(),
				response
			};
		}

		it('reports the feature flag and allowlist size without the ids', async () => {
			const { json, text } = await body();

			expect(json.campaignsEnabled).toBe(true);
			expect(json.pilotAllowlistSize).toBe(2);
			expect(text).not.toContain(GM_USER_ID);
			expect(text).not.toContain('player-a');
		});

		it('never leaks a campaign, session or invite identifier', async () => {
			const { text } = await body();

			for (const canary of [CAMPAIGN_ID, GM_USER_ID, INVITE_CANARY]) {
				expect(text).not.toContain(canary);
			}
		});

		it('is not cacheable by a shared cache', async () => {
			const { response } = await body();
			expect(response.headers.get('Cache-Control')).toBe('private, no-store');
		});

		it('reports D1 reachability, migration presence and session counts', async () => {
			const { json } = await body();

			expect(json.database.reachable).toBe(true);
			expect(json.database.activeSessions).toBe(0);
			expect(json.database.frozenSessions).toBe(0);
			expect(json.database.oldestFrozenAgeSeconds).toBeNull();
			// The fixture applies migration SQL directly, so neither tracking
			// table exists — `null` is the honest answer, not a crash.
			expect(json.database.migrationsApplied).toBeNull();
		});

		it('counts applied migrations when the tracking table exists', async () => {
			// Without this the `null` above proves nothing: the lookup swallows a
			// driver error, so a query that never worked at all would also read
			// as "no tracking table".
			sqlite.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT)');
			sqlite.exec("INSERT INTO d1_migrations (name) VALUES ('0000'), ('0001'), ('0002')");

			const { json } = await body();
			expect(json.database.migrationsApplied).toBe(3);
		});

		it('reports an unreachable database without throwing', async () => {
			mocks.getDb.mockRejectedValue(new Error('D1_ERROR: connection lost'));
			const { json, text } = await body();

			expect(json.database.reachable).toBe(false);
			expect(json.database.activeSessions).toBeNull();
			// The driver message can carry connection detail — it must not ride
			// out in the response.
			expect(text).not.toContain('D1_ERROR');
		});

		it('reports the pinned content digest deployments are compared against', async () => {
			const { json } = await body();

			expect(json.content.packId).toBe('hmtw');
			expect(typeof json.content.packVersion).toBe('string');
			expect(json.content.runtimeDigest).toMatch(/^[a-f0-9]{16,}$/);
		});

		it('reports which rate-limit bindings are present and which are missing', async () => {
			const withOne = await body({
				platformEnv: { CAMPAIGN_POLL_LIMITER: { limit: async () => ({ success: true }) } }
			});

			expect(withOne.json.rateLimit.bindingsPresent).toEqual(['CAMPAIGN_POLL_LIMITER']);
			expect(withOne.json.rateLimit.bindingsMissing).toEqual([
				'CAMPAIGN_SESSION_COMMAND_LIMITER',
				'CAMPAIGN_MUTATION_LIMITER',
				'CAMPAIGN_JOIN_LIMITER'
			]);
			expect(withOne.json.rateLimit.degradedPolls).toBe(0);
		});

		it('reports every binding missing when the platform has none', async () => {
			const { json } = await body();
			expect(json.rateLimit.bindingsPresent).toEqual([]);
			expect(json.rateLimit.bindingsMissing).toHaveLength(4);
		});
	});

	describe('frozen session reporting', () => {
		function seedFrozenSession(sessionId: string, frozenAtSeconds: number): void {
			sqlite
				.prepare(
					`INSERT INTO play_sessions (
						id, campaign_id, sequence, status, phase, content_pack_id,
						content_pack_version, content_digest, version,
						public_state_json, started_at
					) VALUES (?, ?, ?, 'frozen', 'crawl', 'hmtw', '3.4.0', 'digest', 1, '{}', ?)`
				)
				.run(sessionId, CAMPAIGN_ID, sessionId === 'sess-1' ? 0 : 1, frozenAtSeconds);
			sqlite
				.prepare(
					`INSERT INTO campaign_events (campaign_id, session_id, kind, public_payload_json, created_at)
					 VALUES (?, ?, 'session-frozen', '{}', ?)`
				)
				.run(CAMPAIGN_ID, sessionId, frozenAtSeconds);
		}

		it('counts frozen sessions and ages the oldest from its freeze event', async () => {
			const nowSeconds = Math.floor(Date.now() / 1000);
			seedFrozenSession('sess-1', nowSeconds - 600);

			const response = await getHealth(
				healthEvent({ authorization: `Bearer ${HEALTH_SECRET}` }) as never
			);
			const json = (await response.json()) as HealthBody;

			expect(json.database.frozenSessions).toBe(1);
			expect(json.database.oldestFrozenAgeSeconds).toBeGreaterThanOrEqual(600);
			expect(json.database.oldestFrozenAgeSeconds).toBeLessThan(660);
			expect(JSON.stringify(json)).not.toContain('sess-1');
		});

		it('ages a re-frozen session from its most recent freeze, not its first', async () => {
			const nowSeconds = Math.floor(Date.now() / 1000);
			seedFrozenSession('sess-1', nowSeconds - 3600);
			// Recovered, then frozen again five minutes ago.
			sqlite
				.prepare(
					`INSERT INTO campaign_events (campaign_id, session_id, kind, public_payload_json, created_at)
					 VALUES (?, 'sess-1', 'session-frozen', '{}', ?)`
				)
				.run(CAMPAIGN_ID, nowSeconds - 300);

			const response = await getHealth(
				healthEvent({ authorization: `Bearer ${HEALTH_SECRET}` }) as never
			);
			const json = (await response.json()) as HealthBody;

			expect(json.database.oldestFrozenAgeSeconds).toBeGreaterThanOrEqual(300);
			expect(json.database.oldestFrozenAgeSeconds).toBeLessThan(360);
		});
	});
});
