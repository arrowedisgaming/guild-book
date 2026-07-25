/**
 * Migration `0007_purge_pinned_sessions` — the one-time purge of every play
 * session whose pinned runtime content predates the `challenge-stun` content
 * fix (28c0cc1) and can therefore never be loaded, recovered, or ended.
 *
 * A destructive migration earns a test for what it must NOT take with it.
 * Sessions, their fragments, their commands, and their session-scoped events
 * go; campaigns, memberships, characters, tenures, and campaign lifecycle
 * history stay. Deletes are re-runnable, so applying the migration a second
 * time against a seeded database is a faithful exercise of it.
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as schema from '$lib/server/db/schema';
import type { AppDbContext } from '$lib/server/db/atomic';
import { startSession } from '$lib/server/session/lifecycle';

const MIGRATIONS_DIR = join(process.cwd(), 'src/lib/server/db/migrations');
const PURGE_MIGRATION = '0007_purge_pinned_sessions.sql';
const GM_USER = 'user-gm';

describe('0007_purge_pinned_sessions', () => {
	let sqlite: Database.Database;
	let ctx: AppDbContext;

	beforeEach(() => {
		sqlite = new Database(':memory:');
		sqlite.pragma('foreign_keys = ON');
		for (const filename of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
			sqlite.exec(readFileSync(join(MIGRATIONS_DIR, filename), 'utf8'));
		}
		ctx = { kind: 'sqlite', db: drizzle(sqlite, { schema }), raw: sqlite };
	});

	afterEach(() => sqlite.close());

	function applyPurge(): void {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, PURGE_MIGRATION), 'utf8'));
	}

	function seedCampaign(): void {
		sqlite.prepare('INSERT INTO users (id) VALUES (?)').run(GM_USER);
		sqlite
			.prepare('INSERT INTO campaigns (id, owner_user_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
			.run('campaign-a', GM_USER, 'The Lantern Guild', '', 100, 100);
		sqlite
			.prepare('INSERT INTO campaign_members (id, campaign_id, user_id, joined_at) VALUES (?, ?, ?, ?)')
			.run('membership-a', 'campaign-a', GM_USER, 100);
	}

	function count(table: string): number {
		return (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
	}

	it('removes every session and its scoped rows, leaving campaign history intact', async () => {
		seedCampaign();
		// A campaign lifecycle event with no session: this must survive.
		sqlite
			.prepare(
				`INSERT INTO campaign_events (campaign_id, membership_id, kind, public_payload_json, created_at)
				 VALUES (?, ?, 'member-joined', '{}', 100)`
			)
			.run('campaign-a', 'membership-a');

		const started = await startSession({ dbContext: ctx, campaignId: 'campaign-a', actorUserId: GM_USER, now: new Date(200_000) });
		expect(started.ok).toBe(true);
		expect(count('play_sessions')).toBe(1);
		expect(count('session_runtime_contents')).toBe(1);
		expect(count('session_server_states')).toBe(1);
		const sessionEventsBefore = (
			sqlite.prepare('SELECT count(*) AS n FROM campaign_events WHERE session_id IS NOT NULL').get() as { n: number }
		).n;
		expect(sessionEventsBefore).toBeGreaterThan(0);

		applyPurge();

		expect(count('play_sessions')).toBe(0);
		expect(count('session_runtime_contents')).toBe(0);
		expect(count('session_server_states')).toBe(0);
		expect(count('session_private_states')).toBe(0);
		expect(count('session_commands')).toBe(0);
		expect(
			(sqlite.prepare('SELECT count(*) AS n FROM campaign_events WHERE session_id IS NOT NULL').get() as { n: number }).n
		).toBe(0);

		// The campaign and its non-session history are untouched.
		expect(count('campaigns')).toBe(1);
		expect(count('campaign_members')).toBe(1);
		expect(count('users')).toBe(1);
		const survivors = sqlite.prepare('SELECT kind FROM campaign_events').all() as { kind: string }[];
		expect(survivors).toEqual([{ kind: 'member-joined' }]);
	});

	it('frees the campaign to start a fresh session afterwards', async () => {
		seedCampaign();
		const first = await startSession({ dbContext: ctx, campaignId: 'campaign-a', actorUserId: GM_USER, now: new Date(200_000) });
		expect(first.ok).toBe(true);

		// The open-session slot is the reason a wedged session is unrecoverable:
		// while it exists, its GM cannot start a replacement.
		const blocked = await startSession({ dbContext: ctx, campaignId: 'campaign-a', actorUserId: GM_USER, now: new Date(300_000) });
		expect(blocked).toEqual({ ok: false, code: 'illegal-command' });

		applyPurge();

		const afterPurge = await startSession({ dbContext: ctx, campaignId: 'campaign-a', actorUserId: GM_USER, now: new Date(400_000) });
		expect(afterPurge.ok).toBe(true);
	});

	it('does not delete tenure rows or their death audit trail', async () => {
		seedCampaign();
		sqlite
			.prepare(
				`INSERT INTO characters (id, user_id, name, data, version, life_status, is_draft, is_archived, created_at, updated_at)
				 VALUES ('character-a', ?, 'Corpse', '{}', 1, 'dead', 0, 0, 100, 100)`
			)
			.run(GM_USER);
		sqlite
			.prepare(
				`INSERT INTO campaign_adventurer_tenures
				 (id, campaign_id, membership_id, character_id, started_at, ended_at, end_reason, death_session_id)
				 VALUES ('tenure-a', 'campaign-a', 'membership-a', 'character-a', 100, 200, 'died', 'session-long-gone')`
			)
			.run();

		applyPurge();

		const tenure = sqlite
			.prepare('SELECT end_reason AS reason, death_session_id AS deathSessionId FROM campaign_adventurer_tenures')
			.get() as { reason: string; deathSessionId: string };
		expect(tenure).toEqual({ reason: 'died', deathSessionId: 'session-long-gone' });
	});
});
