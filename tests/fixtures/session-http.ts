/**
 * Shared HTTP-layer test plumbing for Task 6's session routes: a real
 * in-memory SQLite DB (migrated, seeded with a campaign/GM/players), and a
 * minimal fake `RequestEvent` builder good enough to invoke the exported
 * `RequestHandler`s directly — real handlers, real `$lib/server/session/*`
 * services, real DB reads/writes. Only authentication (`ensureUser`) is
 * mocked by the calling test file (see `session-api.test.ts`/
 * `session-privacy.test.ts`) — this module never touches `vi.mock` itself,
 * since Vitest's mock hoisting is per-test-file and must stay visible at
 * each test file's own top level.
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as schema from '$lib/server/db/schema';
import type { AppDbContext } from '$lib/server/db/atomic';

export function applyMigrations(sqlite: Database.Database): void {
	const directory = join(process.cwd(), 'src/lib/server/db/migrations');
	for (const filename of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
		sqlite.exec(readFileSync(join(directory, filename), 'utf8'));
	}
}

export interface FoundationOptions {
	campaignId?: string;
	gmUserId?: string;
	playerUserIds?: string[];
}

/** Seeds one campaign owned by `gmUserId` with `playerUserIds` as active
 * members — the minimum every session route needs to resolve a real role
 * via the real (unmocked) `requireCampaignAccess`. */
export function seedCampaignFoundation(sqlite: Database.Database, options: FoundationOptions = {}): { campaignId: string; gmUserId: string; playerUserIds: string[] } {
	const campaignId = options.campaignId ?? 'campaign-a';
	const gmUserId = options.gmUserId ?? 'gm-a';
	const playerUserIds = options.playerUserIds ?? ['player-a', 'player-b'];

	for (const userId of [gmUserId, ...playerUserIds]) {
		sqlite.prepare('INSERT INTO users (id) VALUES (?)').run(userId);
	}
	sqlite
		.prepare('INSERT INTO campaigns (id, owner_user_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
		.run(campaignId, gmUserId, 'The Lantern Guild', '', 100, 100);
	for (const userId of playerUserIds) {
		sqlite
			.prepare('INSERT INTO campaign_members (id, campaign_id, user_id, joined_at) VALUES (?, ?, ?, ?)')
			.run(`member-${userId}`, campaignId, userId, 100);
	}

	return { campaignId, gmUserId, playerUserIds };
}

export function makeDbContext(sqlite: Database.Database): AppDbContext {
	return { kind: 'sqlite', db: drizzle(sqlite, { schema }), raw: sqlite };
}

export interface FakeEventOptions {
	method?: string;
	campaignId: string;
	sessionId?: string;
	body?: unknown;
	searchParams?: Record<string, string>;
}

/** A fake `RequestEvent` good enough for our route handlers: a real
 * `Request` (so `await request.json()` works), `params`, a real `URL` (so
 * `event.url.searchParams` works), and `platform.env.CAMPAIGNS_ENABLED`
 * (read by `getEnv`, unmocked in these tests) set on. `setHeaders` is a
 * no-op spy — the routes' own explicit `campaignHeaders()` on every `json()`/
 * `Response` call is what the tests actually assert against, matching
 * Increment 1's own double-header-application pattern. */
export function fakeEvent(options: FakeEventOptions): { request: Request; params: Record<string, string>; url: URL; platform: { env: Record<string, string> }; setHeaders: (headers: Record<string, string>) => void } {
	const params: Record<string, string> = { id: options.campaignId };
	if (options.sessionId) params.sessionId = options.sessionId;

	const url = new URL(`http://localhost/api/campaigns/${options.campaignId}${options.sessionId ? `/sessions/${options.sessionId}` : ''}`);
	for (const [key, value] of Object.entries(options.searchParams ?? {})) url.searchParams.set(key, value);

	return {
		request: new Request(url, {
			method: options.method ?? 'GET',
			headers: { 'Content-Type': 'application/json' },
			...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
		}),
		params,
		url,
		platform: { env: { CAMPAIGNS_ENABLED: 'true' } },
		setHeaders: () => {}
	};
}
