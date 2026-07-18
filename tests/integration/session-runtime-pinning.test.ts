import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { compileSessionRuntimeContent, parseSessionRuntimeContent, toSessionEngineRuntime } from '$lib/server/content/session-runtime';
import { getContentPack, getTarotProcedures } from '$lib/server/content/loader';
import { reduceSession, type ReduceContext } from '$lib/engine/session/reducer';
import { makeRng } from '$lib/engine/rng';
import { makeSessionFixture } from '../fixtures/session';
import type { SessionActor, SessionRuntimeContentV1 } from '$lib/types/session';

/**
 * Proves deployment pinning (task-4-brief Step 3 / controller amendment 4):
 * a session's runtime content, once compiled and persisted, keeps governing
 * that session even after the "live" bundled content pack changes — because
 * the command service (Task 5) always loads the persisted
 * `session_runtime_contents` row, never the live bundle, for an existing
 * session. This is a DB round trip (per amendment 4, kept in
 * `tests/integration/` rather than `tests/unit/session-runtime.test.ts`)
 * because the proof is precisely about what a real read *from storage*
 * yields, not about two in-memory objects that merely `toEqual` each other.
 */
describe('session runtime content — deployment pinning', () => {
	let sqlite: Database.Database;

	beforeEach(() => {
		sqlite = new Database(':memory:');
		sqlite.pragma('foreign_keys = ON');
		applyMigrations(sqlite);
		seedFoundation(sqlite);
	});

	afterEach(() => sqlite.close());

	it('a reload after a live content-pack change still yields the originally-pinned (v1) content', () => {
		const v1Pack = getContentPack();
		const proceduresFile = getTarotProcedures();
		const v1Content = compileSessionRuntimeContent({ pack: v1Pack, proceduresFile });

		insertSession(sqlite, {
			id: 'session-a',
			campaignId: 'campaign-a',
			contentPackId: v1Content.contentPackId,
			contentPackVersion: v1Content.contentPackVersion,
			contentDigest: v1Content.contentDigest
		});
		insertRuntimeContent(sqlite, { sessionId: 'session-a', content: v1Content });

		// The "deployment" moves on: a v2 pack drops the wands suit entirely
		// (a stand-in for "content changed under the session's feet"). This
		// mutates nothing already persisted — it only represents what
		// `getContentPack()`/a fresh compile would now produce if the
		// service mistakenly consulted the live bundle instead of the pin.
		const v2Pack = { ...v1Pack, tarot: { ...v1Pack.tarot, suits: v1Pack.tarot.suits.filter((s) => s !== 'wands') } };
		const v2Content = compileSessionRuntimeContent({ pack: v2Pack, proceduresFile });
		expect(v2Content.contentDigest).not.toBe(v1Content.contentDigest);
		expect(v2Content.cards.length).toBeLessThan(v1Content.cards.length);

		// Reload the persisted session's runtime content from the DB row —
		// this is what Task 5's command service does at every command, not
		// just at session start.
		const reloaded = reloadRuntimeContent(sqlite, 'session-a');

		expect(reloaded).toEqual(v1Content);
		expect(reloaded.contentDigest).toBe(v1Content.contentDigest);
		expect(reloaded.cards).toHaveLength(78);

		// What the reducer actually receives, built from the persisted
		// snapshot, must behave like v1 — a freshly-dealt, full 78-card
		// session (built against the real, unmutated `getContentPack()`)
		// reduces cleanly.
		const gm: SessionActor = { kind: 'gm', userId: 'gm-1' };
		const state = makeSessionFixture('pinning-test');
		const pinnedContext: ReduceContext = {
			actor: gm,
			runtime: toSessionEngineRuntime(reloaded),
			rng: makeRng('pinning-test')
		};
		const pinnedResult = reduceSession(
			state,
			{ type: 'draw', deck: 'major', destinationZoneId: 'gmHand', count: 1 },
			pinnedContext
		);
		expect(pinnedResult.ok).toBe(true);

		// Had the service instead used the "live" (v2) bundle for this same
		// pre-existing 78-card session, it would break — the state still
		// holds wand cards a v2 catalog no longer recognizes. This contrast
		// is the proof that pinning matters, not just that reload works.
		const liveV2Context: ReduceContext = {
			actor: gm,
			runtime: toSessionEngineRuntime(v2Content),
			rng: makeRng('pinning-test')
		};
		expect(() =>
			reduceSession(state, { type: 'draw', deck: 'major', destinationZoneId: 'gmHand', count: 1 }, liveV2Context)
		).toThrow(/card catalog/i);
	});
});

function applyMigrations(sqlite: Database.Database): void {
	const directory = join(process.cwd(), 'src/lib/server/db/migrations');
	for (const filename of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
		sqlite.exec(readFileSync(join(directory, filename), 'utf8'));
	}
}

function seedFoundation(sqlite: Database.Database): void {
	sqlite.prepare('INSERT INTO users (id) VALUES (?)').run('owner-a');
	sqlite
		.prepare(
			'INSERT INTO campaigns (id, owner_user_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
		)
		.run('campaign-a', 'owner-a', 'The Lantern Guild', '', 100, 100);
}

function insertSession(
	sqlite: Database.Database,
	options: {
		id: string;
		campaignId: string;
		contentPackId: string;
		contentPackVersion: string;
		contentDigest: string;
	}
) {
	return sqlite
		.prepare(
			`INSERT INTO play_sessions
				(id, campaign_id, sequence, status, phase, content_pack_id, content_pack_version,
				 procedure_schema_version, content_digest, version, public_state_schema_version,
				 public_state_json, started_at, started_by_user_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			options.id,
			options.campaignId,
			1,
			'active',
			'crawl',
			options.contentPackId,
			options.contentPackVersion,
			1,
			options.contentDigest,
			0,
			1,
			'{}',
			100,
			'owner-a'
		);
}

function insertRuntimeContent(
	sqlite: Database.Database,
	options: { sessionId: string; content: SessionRuntimeContentV1 }
) {
	return sqlite
		.prepare(
			`INSERT INTO session_runtime_contents (session_id, schema_version, session_version, runtime_content_json, created_at)
			 VALUES (?, ?, ?, ?, ?)`
		)
		.run(options.sessionId, options.content.schemaVersion, 0, JSON.stringify(options.content), 100);
}

/** Reads a session's pinned runtime content back out of storage exactly the
 * way a real read path would: raw JSON column -> `JSON.parse` -> re-validate
 * against the schema (the "after read" gate). */
function reloadRuntimeContent(sqlite: Database.Database, sessionId: string): SessionRuntimeContentV1 {
	const row = sqlite
		.prepare('SELECT runtime_content_json AS json FROM session_runtime_contents WHERE session_id = ?')
		.get(sessionId) as { json: string };
	return parseSessionRuntimeContent(JSON.parse(row.json));
}
