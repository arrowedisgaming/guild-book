import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as schema from '$lib/server/db/schema';
import type { AppDbContext } from '$lib/server/db/atomic';
import { executeCommand } from '$lib/server/session/command-service';
import { endSession, recoverSession, startSession } from '$lib/server/session/lifecycle';
import { canonicalJsonStringify, sha256Hex } from '$lib/server/content/canonical-json';
import type { SessionCommandEnvelope, SessionCommand } from '$lib/types/session';

/**
 * TDD Step 1 (task-5-brief): failing idempotency/contention tests, written
 * before `command-service.ts` existed. Now exercised against the real
 * implementation with a real SQLite DB — no mocks.
 */
describe('session command service — idempotency and contention', () => {
	let sqlite: Database.Database;
	let ctx: AppDbContext;

	beforeEach(() => {
		sqlite = new Database(':memory:');
		sqlite.pragma('foreign_keys = ON');
		applyMigrations(sqlite);
		seedFoundation(sqlite);
		ctx = { kind: 'sqlite', db: drizzle(sqlite, { schema }), raw: sqlite };
	});

	afterEach(() => sqlite.close());

	async function startFixtureSession() {
		const result = await startSession({
			dbContext: ctx,
			campaignId: 'campaign-a',
			actorUserId: 'gm-a',
			sessionId: 'session-a',
			shuffleSeed: 'deterministic-seed',
			now: new Date(1_000)
		});
		if (!result.ok) throw new Error(`fixture session failed to start: ${result.code}`);
		return result;
	}

	function drawEnvelope(commandId: string, count = 1): SessionCommandEnvelope<SessionCommand> {
		return {
			commandId,
			observedSessionVersion: 1,
			command: { type: 'draw', deck: 'player', destinationZoneId: 'hand:player-a', count }
		};
	}

	it('replays the identical stored outcome for a duplicate (sessionId, commandId) with the same hash', async () => {
		await startFixtureSession();
		const envelope = drawEnvelope('command-1');

		const first = await executeCommand({ dbContext: ctx, campaignId: 'campaign-a', sessionId: 'session-a', actorUserId: 'player-a', envelope });
		expect(first.outcome).toEqual({ ok: true, resultingVersion: 2 });

		const duplicate = await executeCommand({ dbContext: ctx, campaignId: 'campaign-a', sessionId: 'session-a', actorUserId: 'player-a', envelope });
		expect(duplicate.outcome).toEqual(first.outcome);

		expect(countCommandRows(sqlite, 'session-a', 'command-1')).toBe(1);
		// The session was NOT re-mutated by the replay: only one draw's worth
		// of version advancement happened.
		expect(currentVersion(sqlite, 'session-a')).toBe(2);
	});

	it('returns a fresh actor projection on a duplicate replay, not a stale cached one', async () => {
		await startFixtureSession();
		const firstEnvelope = drawEnvelope('command-1');
		await executeCommand({ dbContext: ctx, campaignId: 'campaign-a', sessionId: 'session-a', actorUserId: 'player-a', envelope: firstEnvelope });

		// Advance the session further with a second, distinct command.
		const secondEnvelope = drawEnvelope('command-2');
		await executeCommand({ dbContext: ctx, campaignId: 'campaign-a', sessionId: 'session-a', actorUserId: 'player-a', envelope: secondEnvelope });

		// Replaying command-1 must reflect the CURRENT version (3), not the
		// version at the time command-1 was first accepted (2).
		const replay = await executeCommand({ dbContext: ctx, campaignId: 'campaign-a', sessionId: 'session-a', actorUserId: 'player-a', envelope: firstEnvelope });
		expect(replay.outcome).toEqual({ ok: true, resultingVersion: 2 });
		expect(replay.projection?.sessionVersion).toBe(3);
	});

	it('rejects a reused commandId with a different canonical command as command-id-reused', async () => {
		await startFixtureSession();
		const envelope = drawEnvelope('command-1');
		await executeCommand({ dbContext: ctx, campaignId: 'campaign-a', sessionId: 'session-a', actorUserId: 'player-a', envelope });

		const changed = await executeCommand({
			dbContext: ctx,
			campaignId: 'campaign-a',
			sessionId: 'session-a',
			actorUserId: 'player-a',
			envelope: { ...envelope, command: { type: 'draw', deck: 'player', destinationZoneId: 'hand:player-a', count: 2 } }
		});
		expect(changed.outcome).toMatchObject({ ok: false, code: 'command-id-reused' });
		// No new row was inserted for the rejected replay attempt.
		expect(countCommandRows(sqlite, 'session-a', 'command-1')).toBe(1);
	});

	it('claims consecutive versions for two racing nonstructural commands from different actors', async () => {
		await startFixtureSession();
		const envelopeA: SessionCommandEnvelope<SessionCommand> = {
			commandId: 'race-a',
			observedSessionVersion: 1,
			command: { type: 'draw', deck: 'player', destinationZoneId: 'hand:player-a', count: 1 }
		};
		const envelopeB: SessionCommandEnvelope<SessionCommand> = {
			commandId: 'race-b',
			observedSessionVersion: 1,
			command: { type: 'draw', deck: 'player', destinationZoneId: 'hand:player-b', count: 1 }
		};

		const [resultA, resultB] = await Promise.all([
			executeCommand({ dbContext: ctx, campaignId: 'campaign-a', sessionId: 'session-a', actorUserId: 'player-a', envelope: envelopeA }),
			executeCommand({ dbContext: ctx, campaignId: 'campaign-a', sessionId: 'session-a', actorUserId: 'player-b', envelope: envelopeB })
		]);

		expect(resultA.outcome.ok).toBe(true);
		expect(resultB.outcome.ok).toBe(true);
		const versions = [resultA.outcome, resultB.outcome]
			.map((outcome) => (outcome.ok ? outcome.resultingVersion : -1))
			.sort((a, b) => a - b);
		expect(versions).toEqual([2, 3]);
		expect(currentVersion(sqlite, 'session-a')).toBe(3);
		expect(countCommandRows(sqlite, 'session-a', 'race-a')).toBe(1);
		expect(countCommandRows(sqlite, 'session-a', 'race-b')).toBe(1);
	});

	it('hard-rejects a structural command whose expectedStructuralVersion has gone stale', async () => {
		await startFixtureSession();
		// Advance the session so the structural command's precondition goes stale.
		await executeCommand({ dbContext: ctx, campaignId: 'campaign-a', sessionId: 'session-a', actorUserId: 'player-a', envelope: drawEnvelope('advance-first') });

		const staleEndRound: SessionCommandEnvelope<SessionCommand> = {
			commandId: 'end-round-1',
			observedSessionVersion: 1,
			expectedStructuralVersion: 1,
			command: { type: 'end-round' }
		};
		const result = await executeCommand({ dbContext: ctx, campaignId: 'campaign-a', sessionId: 'session-a', actorUserId: 'gm-a', envelope: staleEndRound });
		expect(result.outcome).toMatchObject({ ok: false, code: 'stale-structure' });
		// A rejected structural command still consumes no version claim.
		expect(currentVersion(sqlite, 'session-a')).toBe(2);
	});

	it('hard-rejects (never retries) a structural command that loses a genuine commit-time claim race', async () => {
		await startFixtureSession();
		// Both read at version 1 concurrently and both pass the precondition
		// check before either commits — the loser must hit the claim-collision
		// branch at commit time, not the earlier precondition check.
		const envelopeA: SessionCommandEnvelope<SessionCommand> = {
			commandId: 'end-round-a',
			observedSessionVersion: 1,
			expectedStructuralVersion: 1,
			command: { type: 'end-round' }
		};
		const envelopeB: SessionCommandEnvelope<SessionCommand> = {
			commandId: 'end-round-b',
			observedSessionVersion: 1,
			expectedStructuralVersion: 1,
			command: { type: 'end-round' }
		};

		const [resultA, resultB] = await Promise.all([
			executeCommand({ dbContext: ctx, campaignId: 'campaign-a', sessionId: 'session-a', actorUserId: 'gm-a', envelope: envelopeA }),
			executeCommand({ dbContext: ctx, campaignId: 'campaign-a', sessionId: 'session-a', actorUserId: 'gm-a', envelope: envelopeB })
		]);

		const outcomes = [resultA.outcome, resultB.outcome];
		const accepted = outcomes.filter((outcome) => outcome.ok);
		const rejected = outcomes.filter((outcome) => !outcome.ok);
		expect(accepted).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		// A genuine hard reject, not `retry-exhausted` — structural commands
		// never retry.
		expect(rejected[0]).toMatchObject({ ok: false, code: 'stale-structure' });
		expect(currentVersion(sqlite, 'session-a')).toBe(2);
	});

	it('accepts a structural command whose expectedStructuralVersion matches the current version', async () => {
		await startFixtureSession();
		const endRound: SessionCommandEnvelope<SessionCommand> = {
			commandId: 'end-round-1',
			observedSessionVersion: 1,
			expectedStructuralVersion: 1,
			command: { type: 'end-round' }
		};
		const result = await executeCommand({ dbContext: ctx, campaignId: 'campaign-a', sessionId: 'session-a', actorUserId: 'gm-a', envelope: endRound });
		expect(result.outcome).toEqual({ ok: true, resultingVersion: 2 });
	});

	it('rejects a command from a non-member actor as not-authorized, without persisting a row', async () => {
		await startFixtureSession();
		const result = await executeCommand({
			dbContext: ctx,
			campaignId: 'campaign-a',
			sessionId: 'session-a',
			actorUserId: 'stranger',
			envelope: drawEnvelope('stranger-command')
		});
		expect(result.outcome).toMatchObject({ ok: false, code: 'not-authorized' });
		expect(result.projection).toBeNull();
		expect(countCommandRows(sqlite, 'session-a', 'stranger-command')).toBe(0);
	});

	it('rejects a coarsely-unauthorized command type (player attempting a GM-only command)', async () => {
		await startFixtureSession();
		const dealByPlayer: SessionCommandEnvelope<SessionCommand> = {
			commandId: 'deal-1',
			observedSessionVersion: 1,
			command: { type: 'deal', deck: 'player', destinationZoneIds: ['hand:player-a'], countPerDestination: 1 }
		};
		const result = await executeCommand({ dbContext: ctx, campaignId: 'campaign-a', sessionId: 'session-a', actorUserId: 'player-a', envelope: dealByPlayer });
		expect(result.outcome).toMatchObject({ ok: false, code: 'not-authorized' });
		// This IS persisted (the actor is a legitimate campaign member; only
		// the specific command type was illegal for their role).
		expect(countCommandRows(sqlite, 'session-a', 'deal-1')).toBe(1);
	});

	it('never leaks a card identity to a player who does not own the drawn card', async () => {
		await startFixtureSession();
		const result = await executeCommand({ dbContext: ctx, campaignId: 'campaign-a', sessionId: 'session-a', actorUserId: 'player-a', envelope: drawEnvelope('command-1') });
		expect(result.outcome.ok).toBe(true);

		const observerResult = await executeCommand({
			dbContext: ctx,
			campaignId: 'campaign-a',
			sessionId: 'session-a',
			actorUserId: 'player-b',
			envelope: drawEnvelope('command-1') // duplicate replay, just to obtain player-b's fresh projection
		});
		const observerProjection = observerResult.projection?.projection;
		// player-b's own projection has no `gmHand` entry (that's GM-only) and
		// certainly no view into player-a's private cards beyond a card-back count.
		expect(observerProjection).not.toHaveProperty('gmHand');
		const serialized = JSON.stringify(observerResult.projection);
		expect(serialized).not.toContain('cups-');
		expect(serialized).not.toContain('swords-');
	});
});

describe('session lifecycle — freeze / recover / end', () => {
	let sqlite: Database.Database;
	let ctx: AppDbContext;

	beforeEach(() => {
		sqlite = new Database(':memory:');
		sqlite.pragma('foreign_keys = ON');
		applyMigrations(sqlite);
		seedFoundation(sqlite);
		ctx = { kind: 'sqlite', db: drizzle(sqlite, { schema }), raw: sqlite };
	});

	afterEach(() => sqlite.close());

	async function startFixtureSession() {
		const result = await startSession({
			dbContext: ctx,
			campaignId: 'campaign-a',
			actorUserId: 'gm-a',
			sessionId: 'session-a',
			shuffleSeed: 'lifecycle-seed',
			now: new Date(1_000)
		});
		if (!result.ok) throw new Error(`fixture session failed to start: ${result.code}`);
		return result;
	}

	it('freezes the session, with a redacted rejection and no card identity in the audit event, when a fragment fails its own schema on load', async () => {
		await startFixtureSession();
		// Corrupt the server-state fragment so it fails `sessionServerFragmentSchema`.
		sqlite.prepare("UPDATE session_server_states SET server_state_json = '{\"not\":\"valid\"}' WHERE session_id = 'session-a'").run();

		const result = await executeCommand({
			dbContext: ctx,
			campaignId: 'campaign-a',
			sessionId: 'session-a',
			actorUserId: 'player-a',
			envelope: { commandId: 'draw-1', observedSessionVersion: 1, command: { type: 'draw', deck: 'player', destinationZoneId: 'hand:player-a', count: 1 } }
		});

		expect(result.outcome).toMatchObject({ ok: false, code: 'illegal-command' });
		expect(result.outcome).not.toHaveProperty('detail');
		expect(result.projection).toBeNull();

		const status = sqlite.prepare("SELECT status FROM play_sessions WHERE id = 'session-a'").get() as { status: string };
		expect(status.status).toBe('frozen');

		const event = sqlite
			.prepare("SELECT kind, public_payload_json AS payload FROM campaign_events WHERE session_id = 'session-a' AND kind = 'session-frozen'")
			.get() as { kind: string; payload: string } | undefined;
		expect(event).toBeDefined();
		expect(event!.payload).not.toMatch(/cups-|swords-|pentacles-|wands-/);
	});

	it('freezes the session when the reducer detects an invariant violation (a corrupted duplicate card)', async () => {
		await startFixtureSession();
		const serverRow = sqlite.prepare("SELECT server_state_json AS json FROM session_server_states WHERE session_id = 'session-a'").get() as { json: string };
		const server = JSON.parse(serverRow.json);
		// Duplicate the top card of the major draw pile into the player draw
		// pile too — violates invariant #4 (a card in more than one zone).
		server.playerDraw = [server.majorDraw[0], ...server.playerDraw];
		sqlite.prepare('UPDATE session_server_states SET server_state_json = ? WHERE session_id = ?').run(JSON.stringify(server), 'session-a');

		const result = await executeCommand({
			dbContext: ctx,
			campaignId: 'campaign-a',
			sessionId: 'session-a',
			actorUserId: 'gm-a',
			envelope: { commandId: 'draw-1', observedSessionVersion: 1, command: { type: 'draw', deck: 'major', destinationZoneId: 'gmHand', count: 1 } }
		});

		expect(result.outcome).toMatchObject({ ok: false, code: 'illegal-command' });
		const status = sqlite.prepare("SELECT status FROM play_sessions WHERE id = 'session-a'").get() as { status: string };
		expect(status.status).toBe('frozen');
	});

	it('lets the GM recover a frozen session back to active', async () => {
		await startFixtureSession();
		sqlite.prepare("UPDATE play_sessions SET status = 'frozen' WHERE id = 'session-a'").run();

		const notGm = await recoverSession({ dbContext: ctx, campaignId: 'campaign-a', sessionId: 'session-a', actorUserId: 'player-a' });
		expect(notGm).toEqual({ ok: false, code: 'not-authorized' });

		const result = await recoverSession({ dbContext: ctx, campaignId: 'campaign-a', sessionId: 'session-a', actorUserId: 'gm-a', expectedVersion: 1 });
		expect(result).toEqual({ ok: true });
		const status = sqlite.prepare("SELECT status FROM play_sessions WHERE id = 'session-a'").get() as { status: string };
		expect(status.status).toBe('active');
	});

	it('rejects recovery with a stale expectedVersion', async () => {
		await startFixtureSession();
		sqlite.prepare("UPDATE play_sessions SET status = 'frozen' WHERE id = 'session-a'").run();

		const result = await recoverSession({ dbContext: ctx, campaignId: 'campaign-a', sessionId: 'session-a', actorUserId: 'gm-a', expectedVersion: 99 });
		expect(result).toEqual({ ok: false, code: 'stale-structure' });
	});

	it('ends a session: stamps a checksum, deletes private state and secrets, and blocks further commands', async () => {
		await startFixtureSession();
		await executeCommand({
			dbContext: ctx,
			campaignId: 'campaign-a',
			sessionId: 'session-a',
			actorUserId: 'player-a',
			envelope: { commandId: 'draw-1', observedSessionVersion: 1, command: { type: 'draw', deck: 'player', destinationZoneId: 'hand:player-a', count: 1 } }
		});

		const result = await endSession({ dbContext: ctx, campaignId: 'campaign-a', sessionId: 'session-a', actorUserId: 'gm-a' });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.publicHistoryChecksum).toMatch(/^[a-f0-9]{64}$/);

		const row = sqlite.prepare("SELECT status, final_public_state_json AS final, public_history_checksum AS checksum FROM play_sessions WHERE id = 'session-a'").get() as {
			status: string;
			final: string;
			checksum: string;
		};
		expect(row.status).toBe('ended');
		expect(row.final).toBeTruthy();
		expect(row.checksum).toBe(result.publicHistoryChecksum);

		expect((sqlite.prepare("SELECT count(*) AS n FROM session_private_states WHERE session_id = 'session-a'").get() as { n: number }).n).toBe(0);
		expect((sqlite.prepare("SELECT server_state_json AS json FROM session_server_states WHERE session_id = 'session-a'").get() as { json: string }).json).toBe('{}');
		expect((sqlite.prepare('SELECT count(*) AS n FROM campaign_event_secrets').get() as { n: number }).n).toBe(0);

		const afterEnd = await executeCommand({
			dbContext: ctx,
			campaignId: 'campaign-a',
			sessionId: 'session-a',
			actorUserId: 'player-a',
			envelope: { commandId: 'draw-2', observedSessionVersion: 2, command: { type: 'draw', deck: 'player', destinationZoneId: 'hand:player-a', count: 1 } }
		});
		expect(afterEnd.outcome).toMatchObject({ ok: false, code: 'illegal-command' });
	});
});

describe('canonical command hashing (amendment 2/3)', () => {
	it('hashes equivalent key order identically', () => {
		const a = { type: 'draw', deck: 'player', destinationZoneId: 'hand:a', count: 2 };
		const b = { count: 2, destinationZoneId: 'hand:a', type: 'draw', deck: 'player' };
		expect(sha256Hex(canonicalJsonStringify(a))).toBe(sha256Hex(canonicalJsonStringify(b)));
	});

	it('hashes distinct array order differently', () => {
		const a = { type: 'reorder-top', zoneId: 'majorDraw', cardIds: ['i', 'ii', 'iii'] };
		const b = { type: 'reorder-top', zoneId: 'majorDraw', cardIds: ['iii', 'ii', 'i'] };
		expect(sha256Hex(canonicalJsonStringify(a))).not.toBe(sha256Hex(canonicalJsonStringify(b)));
	});
});

function countCommandRows(sqlite: Database.Database, sessionId: string, commandId: string): number {
	const row = sqlite
		.prepare('SELECT count(*) AS count FROM session_commands WHERE session_id = ? AND command_id = ?')
		.get(sessionId, commandId) as { count: number };
	return row.count;
}

function currentVersion(sqlite: Database.Database, sessionId: string): number {
	const row = sqlite.prepare('SELECT version FROM play_sessions WHERE id = ?').get(sessionId) as { version: number };
	return row.version;
}

function applyMigrations(sqlite: Database.Database): void {
	const directory = join(process.cwd(), 'src/lib/server/db/migrations');
	for (const filename of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
		sqlite.exec(readFileSync(join(directory, filename), 'utf8'));
	}
}

function seedFoundation(sqlite: Database.Database): void {
	for (const userId of ['gm-a', 'player-a', 'player-b']) {
		sqlite.prepare('INSERT INTO users (id) VALUES (?)').run(userId);
	}
	sqlite
		.prepare('INSERT INTO campaigns (id, owner_user_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
		.run('campaign-a', 'gm-a', 'The Lantern Guild', '', 100, 100);
	sqlite
		.prepare('INSERT INTO campaign_members (id, campaign_id, user_id, joined_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?)')
		.run('member-a', 'campaign-a', 'player-a', 100, 'member-b', 'campaign-a', 'player-b', 100);
}
