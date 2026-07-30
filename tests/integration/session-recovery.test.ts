import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as schema from '$lib/server/db/schema';
import type { AppDbContext } from '$lib/server/db/atomic';
import { executeCommand } from '$lib/server/session/command-service';
import { recoverSession, startSession } from '$lib/server/session/lifecycle';
import { archiveCampaign } from '$lib/server/campaign/membership';
import { livePlaySessionStatePort } from '$lib/server/session/member-cleanup';
import type { SessionCommand, SessionCommandEnvelope } from '$lib/types/session';

/**
 * Increment 5 Task 5 Step 1 — the AUTOMATIC freeze path, which
 * `tests/e2e/campaign-recovery.spec.ts` cannot reach.
 *
 * The E2E spec covers the GM-driven lifecycle through a real browser. It cannot
 * cover the scenario the plan actually cares most about — a session whose
 * persisted fragments can no longer be trusted — because reaching that state
 * requires corrupting the database directly, and the only way to expose it to a
 * browser would be a test-only corruption endpoint. That is a production attack
 * surface added for a test's convenience, so the corruption lives here instead,
 * where the database is in hand.
 *
 * What matters, and what these tests pin:
 *
 *   1. Every distinct integrity failure freezes the session rather than
 *      half-applying a command against state that cannot be reassembled.
 *   2. The player is told nothing about the failure. `SessionLoadIntegrityError`
 *      messages name tables and columns; none of that may reach the wire, and no
 *      card identity may either.
 *   3. A frozen session is genuinely recoverable once the fragment is repaired —
 *      freeze must be a pause, not a grave.
 *   4. A campaign cannot be archived out from under a frozen session.
 *
 * All three corruption modes below are real branches of `loadSessionForReduce`
 * (`repository.ts`): a mismatched pinned content digest, a fragment at the wrong
 * session version, and a fragment that fails its own schema.
 */
describe('session recovery — automatic freeze on an integrity failure', () => {
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

	function drawEnvelope(commandId: string): SessionCommandEnvelope<SessionCommand> {
		return {
			commandId,
			observedSessionVersion: 1,
			command: { type: 'draw', deck: 'player', destinationZoneId: 'hand:player-a', count: 1 }
		};
	}

	function runCommand(commandId: string) {
		return executeCommand({
			dbContext: ctx,
			campaignId: 'campaign-a',
			sessionId: 'session-a',
			actorUserId: 'player-a',
			envelope: drawEnvelope(commandId)
		});
	}

	function sessionStatus(): string {
		const row = sqlite.prepare('SELECT status FROM play_sessions WHERE id = ?').get('session-a') as
			| { status: string }
			| undefined;
		if (!row) throw new Error('fixture session disappeared');
		return row.status;
	}

	/** The three ways `loadSessionForReduce` can decide the fragments are no
	 * longer trustworthy. Each is a real branch, not a synthetic throw. */
	const CORRUPTIONS: Array<{ label: string; apply: () => void }> = [
		{
			label: 'a pinned content digest that no longer matches the session',
			apply: () => {
				sqlite
					.prepare('UPDATE play_sessions SET content_digest = ? WHERE id = ?')
					.run('0'.repeat(64), 'session-a');
			}
		},
		{
			label: 'a server-state fragment stranded at a different session version',
			apply: () => {
				sqlite
					.prepare('UPDATE session_server_states SET session_version = session_version + 5 WHERE session_id = ?')
					.run('session-a');
			}
		},
		{
			label: 'a server-state fragment that fails its own schema',
			apply: () => {
				sqlite
					.prepare('UPDATE session_server_states SET server_state_json = ? WHERE session_id = ?')
					.run(JSON.stringify({ notAFragment: true }), 'session-a');
			}
		}
	];

	for (const corruption of CORRUPTIONS) {
		it(`freezes the session and refuses the command on ${corruption.label}`, async () => {
			await startFixtureSession();
			expect(sessionStatus()).toBe('active');

			corruption.apply();

			const result = await runCommand('command-after-corruption');

			// Refused, not half-applied.
			expect(result.outcome.ok).toBe(false);
			expect(result.projection).toBeNull();
			// And the table is frozen, so the next actor cannot walk into the same
			// broken state.
			expect(sessionStatus()).toBe('frozen');
		});

		it(`leaks no internal detail to the caller on ${corruption.label}`, async () => {
			await startFixtureSession();
			corruption.apply();

			const result = await runCommand('command-redaction-check');
			const serialized = JSON.stringify(result);

			// `SessionLoadIntegrityError` messages name the table or column at
			// fault ("server state fragment is at a different version…"). Useful in
			// a log, never on the wire.
			for (const forbidden of [
				'server_state',
				'server state',
				'session_server_states',
				'content_digest',
				'digest mismatch',
				'fragment',
				'schema',
				'ZodError'
			]) {
				expect(serialized).not.toContain(forbidden);
			}
		});
	}

	it('recovers a frozen session once the fragment is repaired, and play resumes', async () => {
		await startFixtureSession();

		// Snapshot the good fragment, then break it — repairing means restoring
		// exactly what the engine wrote, which is what a real recovery does.
		const good = sqlite
			.prepare('SELECT server_state_json, session_version FROM session_server_states WHERE session_id = ?')
			.get('session-a') as { server_state_json: string; session_version: number };

		sqlite
			.prepare('UPDATE session_server_states SET server_state_json = ? WHERE session_id = ?')
			.run(JSON.stringify({ notAFragment: true }), 'session-a');

		const refused = await runCommand('command-while-broken');
		expect(refused.outcome.ok).toBe(false);
		expect(sessionStatus()).toBe('frozen');

		// The freeze claimed a version, so the repaired fragment has to be
		// re-stamped to the session's CURRENT version — a fragment restored at its
		// old version is still an integrity failure, which is exactly the trap an
		// operator following the runbook could fall into.
		const frozenVersion = (
			sqlite.prepare('SELECT version FROM play_sessions WHERE id = ?').get('session-a') as { version: number }
		).version;
		expect(frozenVersion).toBeGreaterThan(good.session_version);
		sqlite
			.prepare('UPDATE session_server_states SET server_state_json = ?, session_version = ? WHERE session_id = ?')
			.run(good.server_state_json, frozenVersion, 'session-a');
		sqlite
			.prepare('UPDATE session_private_states SET session_version = ? WHERE session_id = ?')
			.run(frozenVersion, 'session-a');

		const recovered = await recoverSession({
			dbContext: ctx,
			campaignId: 'campaign-a',
			sessionId: 'session-a',
			actorUserId: 'gm-a'
		});
		expect(recovered.ok).toBe(true);
		expect(sessionStatus()).toBe('active');

		// Recovery is only real if the table works afterwards.
		const afterRecovery = await executeCommand({
			dbContext: ctx,
			campaignId: 'campaign-a',
			sessionId: 'session-a',
			actorUserId: 'player-a',
			envelope: {
				commandId: 'command-after-recovery',
				observedSessionVersion: (
					sqlite.prepare('SELECT version FROM play_sessions WHERE id = ?').get('session-a') as { version: number }
				).version,
				command: { type: 'draw', deck: 'player', destinationZoneId: 'hand:player-a', count: 1 }
			}
		});
		expect(afterRecovery.outcome.ok).toBe(true);
	});

	it('refuses to archive the campaign while a session is frozen', async () => {
		// The archive boundary must hold for `frozen`, not just `active`. A frozen
		// session is precisely the state an operator is tempted to archive their
		// way out of, and doing so would strand it beyond recovery.
		await startFixtureSession();
		sqlite
			.prepare('UPDATE session_server_states SET server_state_json = ? WHERE session_id = ?')
			.run(JSON.stringify({ notAFragment: true }), 'session-a');
		await runCommand('command-to-force-freeze');
		expect(sessionStatus()).toBe('frozen');

		const db = drizzle(sqlite, { schema });
		const result = await archiveCampaign(
			db as never,
			{ campaignId: 'campaign-a', ownerUserId: 'gm-a' },
			livePlaySessionStatePort(db as never)
		);

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('session-active');
		// Not half-archived.
		const archivedAt = (
			sqlite.prepare('SELECT archived_at FROM campaigns WHERE id = ?').get('campaign-a') as {
				archived_at: number | null;
			}
		).archived_at;
		expect(archivedAt).toBeNull();
	});
});

function applyMigrations(sqlite: Database.Database): void {
	const directory = join(process.cwd(), 'src/lib/server/db/migrations');
	for (const filename of readdirSync(directory)
		.filter((name) => name.endsWith('.sql'))
		.sort()) {
		sqlite.exec(readFileSync(join(directory, filename), 'utf8'));
	}
}

function seedFoundation(sqlite: Database.Database): void {
	for (const userId of ['gm-a', 'player-a', 'player-b']) {
		sqlite.prepare('INSERT INTO users (id) VALUES (?)').run(userId);
	}
	sqlite
		.prepare(
			'INSERT INTO campaigns (id, owner_user_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
		)
		.run('campaign-a', 'gm-a', 'The Lantern Guild', '', 100, 100);
	sqlite
		.prepare('INSERT INTO campaign_members (id, campaign_id, user_id, joined_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?)')
		.run('member-a', 'campaign-a', 'player-a', 100, 'member-b', 'campaign-a', 'player-b', 100);
}
