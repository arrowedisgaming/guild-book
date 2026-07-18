import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyMigrations, fakeEvent, makeDbContext, seedCampaignFoundation } from '../fixtures/session-http';
import { resetCursorHintsForTest } from '$lib/server/session/latest-cursor';
import type { AppDbContext } from '$lib/server/db/atomic';

/**
 * TDD Step 2 (task-6-brief): HTTP-contract tests for the six session route
 * handlers, invoked directly (real `RequestHandler`s, real Task 5 services,
 * real SQLite) — only `ensureUser` is mocked, same pattern as
 * `tests/unit/campaign-access.test.ts` and `session-privacy.test.ts`.
 */

const mocks = vi.hoisted(() => ({
	ensureUser: vi.fn(),
	getEnv: vi.fn((event: { platform?: { env?: Record<string, string> } }, key: string) => event.platform?.env?.[key]),
	getDb: vi.fn(),
	getDbContext: vi.fn()
}));

vi.mock('$lib/server/auth', () => ({ ensureUser: mocks.ensureUser, getEnv: mocks.getEnv }));
vi.mock('$lib/server/db', () => ({ getDb: mocks.getDb, getDbContext: mocks.getDbContext }));

import { GET as getSessions, POST as postSessions } from '../../src/routes/api/campaigns/[id]/sessions/+server';
import { GET as getSession, PATCH as patchSession } from '../../src/routes/api/campaigns/[id]/sessions/[sessionId]/+server';
import { POST as postCommand } from '../../src/routes/api/campaigns/[id]/sessions/[sessionId]/commands/+server';
import { GET as getSync } from '../../src/routes/api/campaigns/[id]/sync/+server';

describe('session HTTP contracts', () => {
	let sqlite: Database.Database;
	let dbContext: AppDbContext;
	let campaignId: string;
	let gmUserId: string;
	let playerAUserId: string;
	let playerBUserId: string;

	beforeEach(() => {
		vi.clearAllMocks();
		// The isolate-local cursor-hint `Map` (`latest-cursor.ts`) is a module
		// singleton shared across every test in this process — without
		// resetting it, a hint recorded by an earlier test's campaign/cursor
		// pairing could (rarely, but not never) collide with this test's and
		// mask a real /sync regression behind a stale 204. Never rely on the
		// hint's TTL alone to keep tests isolated.
		resetCursorHintsForTest();
		sqlite = new Database(':memory:');
		sqlite.pragma('foreign_keys = ON');
		applyMigrations(sqlite);
		const foundation = seedCampaignFoundation(sqlite);
		campaignId = foundation.campaignId;
		gmUserId = foundation.gmUserId;
		[playerAUserId, playerBUserId] = foundation.playerUserIds;

		dbContext = makeDbContext(sqlite);
		mocks.getDb.mockResolvedValue(dbContext.db);
		mocks.getDbContext.mockResolvedValue(dbContext);
	});

	afterEach(() => sqlite.close());

	async function startAsGm(): Promise<string> {
		mocks.ensureUser.mockResolvedValue(gmUserId);
		const response = await postSessions(fakeEvent({ method: 'POST', campaignId }) as never);
		expect(response.status).toBe(201);
		const body = (await response.json()) as { sessionId: string };
		return body.sessionId;
	}

	describe('POST /sessions', () => {
		it('lets the GM start a session with a 201, a fresh GM projection, and private no-store headers', async () => {
			mocks.ensureUser.mockResolvedValue(gmUserId);
			const response = await postSessions(fakeEvent({ method: 'POST', campaignId }) as never);

			expect(response.status).toBe(201);
			expect(response.headers.get('cache-control')).toBe('private, no-store');
			const body = (await response.json()) as { sessionId: string; session: { projection: { gmHand: unknown[] } } };
			expect(body.sessionId).toBeTruthy();
			expect(body.session.projection).toHaveProperty('gmHand');
		});

		it('denies a player starting a session with the same 404 as a nonexistent campaign', async () => {
			mocks.ensureUser.mockResolvedValue(playerAUserId);
			await expect(postSessions(fakeEvent({ method: 'POST', campaignId }) as never)).rejects.toMatchObject({
				status: 404
			});
		});

		it('denies a nonmember with a 404', async () => {
			mocks.ensureUser.mockResolvedValue('stranger');
			await expect(postSessions(fakeEvent({ method: 'POST', campaignId }) as never)).rejects.toMatchObject({
				status: 404
			});
		});

		it('rejects starting a second session while one is already active', async () => {
			await startAsGm();
			mocks.ensureUser.mockResolvedValue(gmUserId);
			await expect(postSessions(fakeEvent({ method: 'POST', campaignId }) as never)).rejects.toMatchObject({
				status: 400
			});
		});
	});

	describe('GET /sessions', () => {
		it('lists the open session summary and ended history, but never the full projection', async () => {
			const sessionId = await startAsGm();
			mocks.ensureUser.mockResolvedValue(playerAUserId);
			const response = await getSessions(fakeEvent({ campaignId }) as never);
			expect(response.status).toBe(200);
			const body = (await response.json()) as { current: { sessionId: string } | null; history: unknown[] };
			expect(body.current?.sessionId).toBe(sessionId);
			expect(body.history).toEqual([]);
		});

		it('moves a session into history once ended', async () => {
			const sessionId = await startAsGm();
			mocks.ensureUser.mockResolvedValue(gmUserId);
			await patchSession(fakeEvent({ method: 'PATCH', campaignId, sessionId, body: { action: 'end' } }) as never);

			const response = await getSessions(fakeEvent({ campaignId }) as never);
			const body = (await response.json()) as { current: unknown; history: Array<{ sessionId: string }> };
			expect(body.current).toBeNull();
			expect(body.history).toHaveLength(1);
			expect(body.history[0].sessionId).toBe(sessionId);
		});
	});

	describe('GET /sessions/[sessionId]', () => {
		it("returns the active session's actor-scoped projection", async () => {
			const sessionId = await startAsGm();
			mocks.ensureUser.mockResolvedValue(playerAUserId);
			const response = await getSession(fakeEvent({ campaignId, sessionId }) as never);
			expect(response.status).toBe(200);
			const body = (await response.json()) as { status: string; session: { projection: unknown } };
			expect(body.status).toBe('active');
			expect(body.session.projection).not.toHaveProperty('gmHand');
		});

		it('returns the sanitized public history once the session has ended', async () => {
			const sessionId = await startAsGm();
			mocks.ensureUser.mockResolvedValue(gmUserId);
			await patchSession(fakeEvent({ method: 'PATCH', campaignId, sessionId, body: { action: 'end' } }) as never);

			mocks.ensureUser.mockResolvedValue(playerAUserId);
			const response = await getSession(fakeEvent({ campaignId, sessionId }) as never);
			expect(response.status).toBe(200);
			const body = (await response.json()) as { status: string; session: { publicHistoryChecksum: string } };
			expect(body.status).toBe('ended');
			expect(body.session.publicHistoryChecksum).toMatch(/^[a-f0-9]{64}$/);
		});

		it('returns 404 for a session id that does not exist', async () => {
			await startAsGm();
			mocks.ensureUser.mockResolvedValue(gmUserId);
			await expect(
				getSession(fakeEvent({ campaignId, sessionId: 'bogus-session' }) as never)
			).rejects.toMatchObject({ status: 404 });
		});

		it('returns 404 for a nonmember, indistinguishable from a missing session', async () => {
			const sessionId = await startAsGm();
			mocks.ensureUser.mockResolvedValue('stranger');
			await expect(getSession(fakeEvent({ campaignId, sessionId }) as never)).rejects.toMatchObject({
				status: 404
			});
		});
	});

	describe('PATCH /sessions/[sessionId]', () => {
		it('lets the GM end an active session and returns a checksum', async () => {
			const sessionId = await startAsGm();
			mocks.ensureUser.mockResolvedValue(gmUserId);
			const response = await patchSession(
				fakeEvent({ method: 'PATCH', campaignId, sessionId, body: { action: 'end' } }) as never
			);
			expect(response.status).toBe(200);
			const body = (await response.json()) as { success: boolean; action: string; publicHistoryChecksum: string };
			expect(body).toMatchObject({ success: true, action: 'end' });
			expect(body.publicHistoryChecksum).toMatch(/^[a-f0-9]{64}$/);
		});

		it('denies a player attempting to end a session with a 404', async () => {
			const sessionId = await startAsGm();
			mocks.ensureUser.mockResolvedValue(playerAUserId);
			await expect(
				patchSession(fakeEvent({ method: 'PATCH', campaignId, sessionId, body: { action: 'end' } }) as never)
			).rejects.toMatchObject({ status: 404 });
		});

		it('rejects an invalid action with a 400', async () => {
			const sessionId = await startAsGm();
			mocks.ensureUser.mockResolvedValue(gmUserId);
			await expect(
				patchSession(fakeEvent({ method: 'PATCH', campaignId, sessionId, body: { action: 'pause' } }) as never)
			).rejects.toMatchObject({ status: 400 });
		});

		it('returns a 409 with a retry hint on a stale expectedVersion', async () => {
			const sessionId = await startAsGm();
			mocks.ensureUser.mockResolvedValue(gmUserId);
			const response = await patchSession(
				fakeEvent({ method: 'PATCH', campaignId, sessionId, body: { action: 'end', expectedVersion: 99 } }) as never
			);
			expect(response.status).toBe(409);
			const body = (await response.json()) as { code: string };
			expect(body.code).toBe('stale-structure');
		});

		it('lets the GM recover a frozen session back to active', async () => {
			const sessionId = await startAsGm();
			sqlite.prepare("UPDATE play_sessions SET status = 'frozen' WHERE id = ?").run(sessionId);
			mocks.ensureUser.mockResolvedValue(gmUserId);
			const response = await patchSession(
				fakeEvent({ method: 'PATCH', campaignId, sessionId, body: { action: 'recover' } }) as never
			);
			expect(response.status).toBe(200);
			const body = (await response.json()) as { success: boolean; session: { projection: unknown } };
			expect(body.success).toBe(true);
			expect(body.session.projection).toHaveProperty('gmHand');
		});

		describe('freeze (review round 1: GM-initiated manual freeze)', () => {
			it('lets the GM freeze an active session — version bumps, and the session stays readable through the route afterward', async () => {
				const sessionId = await startAsGm();
				mocks.ensureUser.mockResolvedValue(gmUserId);
				const response = await patchSession(
					fakeEvent({ method: 'PATCH', campaignId, sessionId, body: { action: 'freeze' } }) as never
				);
				expect(response.status).toBe(200);
				const body = (await response.json()) as { success: boolean; action: string; session: { projection: unknown } };
				expect(body).toMatchObject({ success: true, action: 'freeze' });
				// The claim-serialized version bump: `startSession` leaves the
				// session at version 1, so a real accepted freeze claim lands it
				// at 2 — confirmed both via the row and via a subsequent read
				// through the route (exercising the freeze branch of the
				// fragment-version-stamp fix through HTTP, not direct SQL).
				const row = sqlite.prepare('SELECT version, status FROM play_sessions WHERE id = ?').get(sessionId) as {
					version: number;
					status: string;
				};
				expect(row).toEqual({ version: 2, status: 'frozen' });
				expect(body.session.projection).toHaveProperty('gmHand');

				const readAfterFreeze = await getSession(fakeEvent({ campaignId, sessionId }) as never);
				expect(readAfterFreeze.status).toBe(200);
				const readBody = (await readAfterFreeze.json()) as { status: string };
				expect(readBody.status).toBe('frozen');
			});

			it('denies a player attempting to freeze a session with a 404', async () => {
				const sessionId = await startAsGm();
				mocks.ensureUser.mockResolvedValue(playerAUserId);
				await expect(
					patchSession(fakeEvent({ method: 'PATCH', campaignId, sessionId, body: { action: 'freeze' } }) as never)
				).rejects.toMatchObject({ status: 404 });
			});

			it('rejects freezing an already-frozen session with a 400, without a spurious version bump', async () => {
				const sessionId = await startAsGm();
				sqlite.prepare("UPDATE play_sessions SET status = 'frozen' WHERE id = ?").run(sessionId);
				mocks.ensureUser.mockResolvedValue(gmUserId);
				await expect(
					patchSession(fakeEvent({ method: 'PATCH', campaignId, sessionId, body: { action: 'freeze' } }) as never)
				).rejects.toMatchObject({ status: 400 });

				const row = sqlite.prepare('SELECT version, status FROM play_sessions WHERE id = ?').get(sessionId) as {
					version: number;
					status: string;
				};
				expect(row).toEqual({ version: 1, status: 'frozen' });
			});

			it('returns a 409 with a retry hint on a stale expectedVersion', async () => {
				const sessionId = await startAsGm();
				mocks.ensureUser.mockResolvedValue(gmUserId);
				const response = await patchSession(
					fakeEvent({ method: 'PATCH', campaignId, sessionId, body: { action: 'freeze', expectedVersion: 99 } }) as never
				);
				expect(response.status).toBe(409);
				const body = (await response.json()) as { code: string };
				expect(body.code).toBe('stale-structure');
			});
		});
	});

	describe('POST /sessions/[sessionId]/commands', () => {
		it('accepts a legal command with a 200 and a fresh actor projection', async () => {
			const sessionId = await startAsGm();
			mocks.ensureUser.mockResolvedValue(playerAUserId);
			const response = await postCommand(
				fakeEvent({
					method: 'POST',
					campaignId,
					sessionId,
					body: {
						commandId: 'draw-1',
						observedSessionVersion: 1,
						command: { type: 'draw', deck: 'player', destinationZoneId: `hand:${playerAUserId}`, count: 1 }
					}
				}) as never
			);
			expect(response.status).toBe(200);
			const body = (await response.json()) as { outcome: { ok: boolean; resultingVersion: number } };
			expect(body.outcome).toEqual({ ok: true, resultingVersion: 2 });
		});

		it('replays a duplicate (same commandId, same command) with a 200', async () => {
			const sessionId = await startAsGm();
			mocks.ensureUser.mockResolvedValue(playerAUserId);
			const envelope = {
				commandId: 'draw-1',
				observedSessionVersion: 1,
				command: { type: 'draw', deck: 'player', destinationZoneId: `hand:${playerAUserId}`, count: 1 }
			};
			await postCommand(fakeEvent({ method: 'POST', campaignId, sessionId, body: envelope }) as never);
			const replay = await postCommand(fakeEvent({ method: 'POST', campaignId, sessionId, body: envelope }) as never);
			expect(replay.status).toBe(200);
			const body = (await replay.json()) as { outcome: { ok: boolean; resultingVersion: number } };
			expect(body.outcome).toEqual({ ok: true, resultingVersion: 2 });
		});

		it('rejects a reused commandId carrying a different command with a 409 (command-id-reused)', async () => {
			const sessionId = await startAsGm();
			mocks.ensureUser.mockResolvedValue(playerAUserId);
			await postCommand(
				fakeEvent({
					method: 'POST',
					campaignId,
					sessionId,
					body: {
						commandId: 'reused-1',
						observedSessionVersion: 1,
						command: { type: 'draw', deck: 'player', destinationZoneId: `hand:${playerAUserId}`, count: 1 }
					}
				}) as never
			);
			const response = await postCommand(
				fakeEvent({
					method: 'POST',
					campaignId,
					sessionId,
					body: {
						commandId: 'reused-1',
						observedSessionVersion: 1,
						command: { type: 'draw', deck: 'player', destinationZoneId: `hand:${playerAUserId}`, count: 2 }
					}
				}) as never
			);
			expect(response.status).toBe(409);
			const body = (await response.json()) as { outcome: { code: string } };
			expect(body.outcome.code).toBe('command-id-reused');
		});

		it('rejects a malformed envelope with a 400', async () => {
			const sessionId = await startAsGm();
			mocks.ensureUser.mockResolvedValue(playerAUserId);
			const response = await postCommand(
				fakeEvent({ method: 'POST', campaignId, sessionId, body: { not: 'an envelope' } }) as never
			);
			expect(response.status).toBe(400);
			const body = (await response.json()) as { outcome: { ok: boolean; code: string } };
			expect(body.outcome).toMatchObject({ ok: false, code: 'illegal-command' });
		});

		it('rejects non-JSON request bodies with a 400', async () => {
			const sessionId = await startAsGm();
			mocks.ensureUser.mockResolvedValue(playerAUserId);
			const event = fakeEvent({ method: 'POST', campaignId, sessionId });
			// Overwrite with a body that fails `request.json()`.
			const badRequest = new Request(event.url, { method: 'POST', body: 'not json', headers: { 'Content-Type': 'application/json' } });
			await expect(postCommand({ ...event, request: badRequest } as never)).rejects.toMatchObject({ status: 400 });
		});

		it('denies a GM-only command type from a player with a 404', async () => {
			const sessionId = await startAsGm();
			mocks.ensureUser.mockResolvedValue(playerAUserId);
			const response = await postCommand(
				fakeEvent({
					method: 'POST',
					campaignId,
					sessionId,
					body: {
						commandId: 'deal-1',
						observedSessionVersion: 1,
						command: { type: 'deal', deck: 'player', destinationZoneIds: [`hand:${playerAUserId}`], countPerDestination: 1 }
					}
				}) as never
			);
			expect(response.status).toBe(404);
		});

		it('denies a nonmember with a 404, indistinguishable from a missing campaign', async () => {
			const sessionId = await startAsGm();
			mocks.ensureUser.mockResolvedValue('stranger');
			await expect(
				postCommand(
					fakeEvent({
						method: 'POST',
						campaignId,
						sessionId,
						body: { commandId: 'x', observedSessionVersion: 1, command: { type: 'end-round' } }
					}) as never
				)
			).rejects.toMatchObject({ status: 404 });
		});

		it('hard-rejects a stale structural command with a 409', async () => {
			const sessionId = await startAsGm();
			mocks.ensureUser.mockResolvedValue(playerAUserId);
			await postCommand(
				fakeEvent({
					method: 'POST',
					campaignId,
					sessionId,
					body: {
						commandId: 'draw-1',
						observedSessionVersion: 1,
						command: { type: 'draw', deck: 'player', destinationZoneId: `hand:${playerAUserId}`, count: 1 }
					}
				}) as never
			);

			mocks.ensureUser.mockResolvedValue(gmUserId);
			const response = await postCommand(
				fakeEvent({
					method: 'POST',
					campaignId,
					sessionId,
					body: {
						commandId: 'end-round-1',
						observedSessionVersion: 1,
						expectedStructuralVersion: 1,
						command: { type: 'end-round' }
					}
				}) as never
			);
			expect(response.status).toBe(409);
			const body = (await response.json()) as { outcome: { code: string } };
			expect(body.outcome.code).toBe('stale-structure');
		});
	});

	describe('GET /sync', () => {
		it('returns 204 with no body when the client is already caught up', async () => {
			await startAsGm();
			mocks.ensureUser.mockResolvedValue(gmUserId);
			const response = await getSync(fakeEvent({ campaignId, searchParams: { after: '1', version: '1' } }) as never);
			expect(response.status).toBe(204);
			expect(response.headers.get('cache-control')).toBe('private, no-store');
			expect(await response.text()).toBe('');
		});

		it('returns the new cursor, events, and session projection once something changed', async () => {
			const sessionId = await startAsGm();
			mocks.ensureUser.mockResolvedValue(gmUserId);
			const response = await getSync(fakeEvent({ campaignId, searchParams: { after: '0', version: '0' } }) as never);
			expect(response.status).toBe(200);
			const body = (await response.json()) as {
				cursor: number;
				events: Array<{ kind: string }>;
				session: { sessionId: string; sessionVersion: number } | null;
			};
			expect(body.cursor).toBeGreaterThan(0);
			expect(body.events.some((event) => event.kind === 'session-started')).toBe(true);
			expect(body.session?.sessionId).toBe(sessionId);
			expect(body.session?.sessionVersion).toBe(1);
		});

		it('detects a session version change even when the event cursor argument is already current', async () => {
			const sessionId = await startAsGm();
			mocks.ensureUser.mockResolvedValue(playerAUserId);
			await postCommand(
				fakeEvent({
					method: 'POST',
					campaignId,
					sessionId,
					body: {
						commandId: 'draw-1',
						observedSessionVersion: 1,
						command: { type: 'draw', deck: 'player', destinationZoneId: `hand:${playerAUserId}`, count: 1 }
					}
				}) as never
			);

			mocks.ensureUser.mockResolvedValue(gmUserId);
			// Fix round 1: the draw above now records a fresh cursor hint
			// (cursor=2) the instant its own commit lands
			// (`recordFreshCursorHintAfterCommit`), same isolate, same process —
			// so without clearing it here, the hint's cursor-only fast path would
			// match this call's `after` and short-circuit to a 204 before ever
			// reaching the version check this test exists to exercise. Clearing
			// it forces the real DB read, which is the thing actually under
			// test: the caller's `after` is already the latest cursor, but their
			// `version` (1) is stale relative to the session's new version (2),
			// and only a real read (never the cursor-only hint) can catch that.
			resetCursorHintsForTest();
			const response = await getSync(fakeEvent({ campaignId, searchParams: { after: '2', version: '1' } }) as never);
			expect(response.status).toBe(200);
			const body = (await response.json()) as { session: { sessionVersion: number } | null };
			expect(body.session?.sessionVersion).toBe(2);
		});

		it('rejects a non-numeric cursor with a 400', async () => {
			await startAsGm();
			mocks.ensureUser.mockResolvedValue(gmUserId);
			await expect(
				getSync(fakeEvent({ campaignId, searchParams: { after: 'nope', version: '0' } }) as never)
			).rejects.toMatchObject({ status: 400 });
		});

		it('rejects a missing cursor param with a 400', async () => {
			await startAsGm();
			mocks.ensureUser.mockResolvedValue(gmUserId);
			await expect(getSync(fakeEvent({ campaignId, searchParams: { after: '0' } }) as never)).rejects.toMatchObject({
				status: 400
			});
		});

		it('denies a nonmember with a 404', async () => {
			await startAsGm();
			mocks.ensureUser.mockResolvedValue('stranger');
			await expect(
				getSync(fakeEvent({ campaignId, searchParams: { after: '0', version: '0' } }) as never)
			).rejects.toMatchObject({ status: 404 });
		});

		it('caps events per response and returns a cursor the client can keep polling from', async () => {
			await startAsGm();
			// Seed far more than the cap directly — cheaper than driving the cap
			// through real commands, and this is purely testing the HTTP layer's
			// truncation/next-cursor behavior, not command semantics.
			const insert = sqlite.prepare(
				'INSERT INTO campaign_events (id, campaign_id, kind, public_payload_json, created_at) VALUES (?, ?, ?, ?, ?)'
			);
			for (let i = 0; i < 250; i++) {
				insert.run(1000 + i, campaignId, 'test-event', JSON.stringify({ i }), Date.now());
			}

			mocks.ensureUser.mockResolvedValue(gmUserId);
			const response = await getSync(fakeEvent({ campaignId, searchParams: { after: '0', version: '1' } }) as never);
			expect(response.status).toBe(200);
			const body = (await response.json()) as { cursor: number; events: unknown[] };
			expect(body.events.length).toBeLessThanOrEqual(200);
			expect(body.cursor).toBeLessThan(1249);
		});
	});
});
