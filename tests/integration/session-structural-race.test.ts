import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as schema from '$lib/server/db/schema';
import type { AppDb } from '$lib/server/db';
import type { AppDbContext } from '$lib/server/db/atomic';
import { executeCommand } from '$lib/server/session/command-service';
import { startSession } from '$lib/server/session/lifecycle';
import { buildAcceptedCommandStatements, loadSessionForReduce } from '$lib/server/session/repository';
import type { SessionCommandEnvelope, SessionCommand } from '$lib/types/session';

/**
 * Issue #14: `expectedStructuralVersion` was validated against the summary
 * read (`command-service.ts` step "cheap status/version check") but the
 * version claim was made from `loadSessionForReduce`, a second, later read.
 * A rival committing between the two reads made the declared precondition
 * stale without either the guard or the resulting-version unique index
 * noticing. On real D1 the window is a ~60ms network round trip; on
 * better-sqlite3 it is too small to ever hit naturally — which is why this
 * file, unlike `session-command-service.test.ts` ("no mocks"), injects the
 * rival through call-through wrappers around the two reads' seams. Each test
 * asserts its wrapper actually fired, so a refactor that moves a seam fails
 * these tests loudly instead of letting them pass without exercising the
 * race.
 */

const hooks = vi.hoisted(() => ({
	beforeLoadSessionForReduce: null as (() => Promise<void>) | null,
	beforeRunAtomic: null as (() => Promise<void>) | null
}));

vi.mock('$lib/server/session/repository', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/session/repository')>();
	return {
		...actual,
		loadSessionForReduce: async (...args: Parameters<typeof actual.loadSessionForReduce>) => {
			// One-shot: cleared before it runs, so the rival's own execution
			// inside the hook passes straight through instead of recursing.
			const hook = hooks.beforeLoadSessionForReduce;
			if (hook) {
				hooks.beforeLoadSessionForReduce = null;
				await hook();
			}
			return actual.loadSessionForReduce(...args);
		}
	};
});

vi.mock('$lib/server/db/atomic', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/db/atomic')>();
	return {
		...actual,
		runAtomic: async (...args: Parameters<typeof actual.runAtomic>) => {
			const hook = hooks.beforeRunAtomic;
			if (hook) {
				hooks.beforeRunAtomic = null;
				await hook();
			}
			return actual.runAtomic(...args);
		}
	};
});

describe('structural command precondition under a mid-flight rival (issue #14)', () => {
	let sqlite: Database.Database;
	let ctx: AppDbContext;

	beforeEach(() => {
		hooks.beforeLoadSessionForReduce = null;
		hooks.beforeRunAtomic = null;
		sqlite = new Database(':memory:');
		sqlite.pragma('foreign_keys = ON');
		applyMigrations(sqlite);
		seedFoundation(sqlite);
		ctx = { kind: 'sqlite', db: drizzle(sqlite, { schema }), raw: sqlite };
	});

	afterEach(() => {
		hooks.beforeLoadSessionForReduce = null;
		hooks.beforeRunAtomic = null;
		sqlite.close();
	});

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
	}

	function endRound(commandId: string, declaredVersion: number): SessionCommandEnvelope<SessionCommand> {
		return {
			commandId,
			observedSessionVersion: declaredVersion,
			expectedStructuralVersion: declaredVersion,
			command: { type: 'end-round' }
		};
	}

	function gmCommand(envelope: SessionCommandEnvelope<SessionCommand>) {
		return executeCommand({ dbContext: ctx, campaignId: 'campaign-a', sessionId: 'session-a', actorUserId: 'gm-a', envelope });
	}

	it('rejects a structural command whose rival committed between the version check and the state load', async () => {
		await startFixtureSession();

		// The rival commits AFTER the victim's summary-read guard has already
		// passed for declared version 1, but BEFORE the victim's
		// `loadSessionForReduce` — the exact window the staging contention
		// harness hit at 3-5% of contended rounds.
		let rivalOutcome: unknown = null;
		let fired = false;
		hooks.beforeLoadSessionForReduce = async () => {
			fired = true;
			rivalOutcome = (await gmCommand(endRound('rival-end-round', 1))).outcome;
		};

		const victim = await gmCommand(endRound('victim-end-round', 1));

		expect(fired).toBe(true);
		expect(rivalOutcome).toEqual({ ok: true, resultingVersion: 2 });
		// Pre-fix this was `{ ok: true, resultingVersion: 3 }`: the round ended
		// twice from one declared precondition — the "table did something the
		// GM did not ask for" outcome from the issue.
		expect(victim.outcome).toMatchObject({ ok: false, code: 'stale-structure' });
		expect(currentVersion()).toBe(2);
		// Both windows reject with `stale-structure`, so pin WHICH check fired:
		// the post-load re-check ran against the version the rival had already
		// produced (2), so the rejection row records expected_version 2 against
		// the declared precondition 1. (The commit-time collision path would
		// have recorded expected_version 1 — see the next test.)
		expect(rejectionRow('victim-end-round')).toEqual({ declared: 1, applied: 2 });
		expectStructuralAuditInvariant();
	});

	it('rejects the loser via the resulting-version claim when the rival commits between the load and the commit', async () => {
		await startFixtureSession();

		// The second half of the window: both structural commands read version 1
		// and pass every precondition check; the rival then commits first, while
		// the victim's accepted batch is on its way to the database. The unique
		// index on (session_id, resulting_version) is the only thing left to
		// serialize them — this pins that it does, deterministically rather than
		// via Promise.all timing luck.
		let rivalOutcome: unknown = null;
		let fired = false;
		hooks.beforeRunAtomic = async () => {
			fired = true;
			rivalOutcome = (await gmCommand(endRound('rival-commit-race', 1))).outcome;
		};

		const victim = await gmCommand(endRound('victim-commit-race', 1));

		expect(fired).toBe(true);
		expect(rivalOutcome).toEqual({ ok: true, resultingVersion: 2 });
		expect(victim.outcome).toMatchObject({ ok: false, code: 'stale-structure' });
		expect(currentVersion()).toBe(2);
		// The victim loaded version 1 BEFORE the rival committed, so this
		// rejection can only have come from the commit-time claim collision —
		// the rejection row records the version it loaded (1), not the version
		// the rival produced (2). If a refactor moved the seam earlier and the
		// post-load re-check fired instead, `applied` would be 2 and this
		// assertion would catch the test no longer exercising its window.
		expect(rejectionRow('victim-commit-race')).toEqual({ declared: 1, applied: 1 });
		expectStructuralAuditInvariant();
	});

	it('refuses to build an accepted claim whose structural precondition differs from its expected version', async () => {
		await startFixtureSession();
		const loaded = await loadSessionForReduce(ctx.db as unknown as AppDb, 'session-a');

		// The staging evidence in miniature: precondition 1, expected 2. The
		// claim builder must throw before anything is written, so a future code
		// path that reopens the two-reads gap fails loudly instead of
		// committing the violation.
		expect(() =>
			buildAcceptedCommandStatements({
				commandRowId: 'guard-row',
				sessionId: 'session-a',
				campaignId: 'campaign-a',
				commandId: 'guard-command',
				actorUserId: 'gm-a',
				requestHash: 'guard-hash',
				commandType: 'end-round',
				clientObservedVersion: 1,
				structuralPreconditionVersion: 1,
				expectedVersion: 2,
				nextState: { ...loaded.engineState, version: 3 },
				events: [],
				shuffleSeed: loaded.shuffleSeed,
				gmUserId: loaded.gmUserId,
				recipientUserIds: loaded.recipientUserIds,
				now: new Date(2_000),
				idFactory: () => 'guard-id'
			})
		).toThrow(/structural precondition/);
	});

	function currentVersion(): number {
		const row = sqlite.prepare('SELECT version FROM play_sessions WHERE id = ?').get('session-a') as { version: number };
		return row.version;
	}

	/** The persisted rejection's precondition/version pair, which records which
	 * check produced it (see the assertions at both call sites). */
	function rejectionRow(commandId: string): { declared: number; applied: number } {
		return sqlite
			.prepare(
				`SELECT structural_precondition_version AS declared, expected_version AS applied
				 FROM session_commands
				 WHERE session_id = 'session-a' AND command_id = ? AND status = 'rejected'`
			)
			.get(commandId) as { declared: number; applied: number };
	}

	/** The invariant the staging rows violated: an ACCEPTED structural claim's
	 * `structural_precondition_version` must equal its `expected_version`.
	 * (Rejected rows are exempt by design — a `stale-structure` rejection row
	 * exists precisely to record the mismatch the actor declared.) */
	function expectStructuralAuditInvariant(): void {
		const rows = sqlite
			.prepare(
				`SELECT structural_precondition_version AS declared, expected_version AS applied
				 FROM session_commands
				 WHERE status = 'accepted' AND structural_precondition_version IS NOT NULL`
			)
			.all() as Array<{ declared: number; applied: number }>;
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(row.declared).toBe(row.applied);
		}
	}
});

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
