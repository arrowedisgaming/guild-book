/**
 * Increment 4 Task 5 Step 1 — the purge/history canary matrix.
 *
 * A fixture session ends holding: a PUBLIC revealed card (its id is the public
 * canary), a private hand and a prepared card (private canaries), a
 * server-held draw order (the server canary is the full draw-pile sequence),
 * and a recipient event secret (a private draw's payload). After `endSession`:
 *
 * - the serialized history CONTAINS the public canary;
 * - it contains NEITHER private canary NOR the server order;
 * - zero `session_private_states` rows and zero `campaign_event_secrets`
 *   rows survive for the session;
 * - the checksum changes if the ordered public history is altered — and is
 *   documented as corruption detection, NOT a signature.
 *
 * Access: the GM and current members read history; a former member (removed
 * after the session ended) and a non-member get `null` (the routes' 404).
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '$lib/server/db/schema';
import type { AppDb } from '$lib/server/db';
import type { AppDbContext } from '$lib/server/db/atomic';
import { applyMigrations, seedCampaignFoundation } from '../fixtures/session-http';
import { startSession, endSession } from '$lib/server/session/lifecycle';
import { executeCommand } from '$lib/server/session/command-service';
import { listCompletedSessions, loadCompletedSessionHistory } from '$lib/server/session/history';
import { canonicalDigest } from '$lib/server/content/canonical-json';

const GM = 'gm-a';
const PLAYER_A = 'player-a';
const PLAYER_B = 'player-b';

describe('completed session history', () => {
	let sqlite: Database.Database;
	let ctx: AppDbContext;
	let db: AppDb;
	let campaignId: string;

	beforeEach(async () => {
		sqlite = new Database(':memory:');
		sqlite.pragma('foreign_keys = ON');
		applyMigrations(sqlite);
		ctx = { kind: 'sqlite', db: drizzle(sqlite, { schema }), raw: sqlite };
		db = ctx.db as unknown as AppDb;
		campaignId = seedCampaignFoundation(sqlite).campaignId;
		const started = await startSession({
			dbContext: ctx,
			campaignId,
			actorUserId: GM,
			sessionId: 'session-h',
			shuffleSeed: 'history-seed',
			now: new Date(200_000)
		});
		if (!started.ok) throw new Error('fixture: session failed to start');
	});

	afterEach(() => sqlite.close());

	async function command(actorUserId: string, commandId: string, command: Record<string, unknown>) {
		const version = (sqlite.prepare("SELECT version FROM play_sessions WHERE id = 'session-h'").get() as { version: number }).version;
		const result = await executeCommand({
			dbContext: ctx,
			campaignId,
			sessionId: 'session-h',
			actorUserId,
			envelope: { commandId, observedSessionVersion: version, command }
		});
		if (!result.outcome.ok) throw new Error(`fixture command ${commandId} rejected: ${JSON.stringify(result.outcome)}`);
	}

	/** Builds the fixture: a public reveal, a private hand card, a prepared
	 * card, and returns the canaries. */
	async function buildAndEnd() {
		// Player A draws two cards privately (their identities are recipient
		// event secrets and private-state rows).
		await command(PLAYER_A, 'draw-1', { type: 'draw', deck: 'player', destinationZoneId: `hand:${PLAYER_A}`, count: 2 });
		const hand = JSON.parse(
			(sqlite.prepare('SELECT private_state_json FROM session_private_states WHERE session_id = ? AND recipient_user_id = ?')
				.get('session-h', PLAYER_A) as { private_state_json: string }).private_state_json
		) as { zones: Array<{ id: string; cards: string[] }> };
		const handCards = hand.zones.find((zone) => zone.id === `hand:${PLAYER_A}`)!.cards;
		const [publicCanary, privateHandCanary] = handCards;

		// One card is PLAYED into the public zone (its face is public history);
		// the other stays in hand (its face must never reach history).
		await command(PLAYER_A, 'play-1', { type: 'play', sourceZoneId: `hand:${PLAYER_A}`, cardId: publicCanary, destinationZoneId: 'played' });
		// And a prepared card — a second private canary in a different zone kind.
		await command(PLAYER_A, 'draw-2', { type: 'draw', deck: 'player', destinationZoneId: `hand:${PLAYER_A}`, count: 1 });
		const hand2 = JSON.parse(
			(sqlite.prepare('SELECT private_state_json FROM session_private_states WHERE session_id = ? AND recipient_user_id = ?')
				.get('session-h', PLAYER_A) as { private_state_json: string }).private_state_json
		) as { zones: Array<{ id: string; cards: string[] }> };
		const preparedCanary = hand2.zones.find((zone) => zone.id === `hand:${PLAYER_A}`)!.cards.at(-1)!;
		await command(PLAYER_A, 'prep-1', {
			type: 'transfer',
			sourceZoneId: `hand:${PLAYER_A}`,
			cardId: preparedCanary,
			destinationZoneId: `prepared:${PLAYER_A}`
		});

		// The server canary: the remaining draw-pile order.
		const serverState = JSON.parse(
			(sqlite.prepare("SELECT server_state_json FROM session_server_states WHERE session_id = 'session-h'").get() as {
				server_state_json: string;
			}).server_state_json
		) as { playerDraw: string[] };
		const serverOrderCanary = JSON.stringify(serverState.playerDraw.slice(0, 8));

		const secretsBefore = (sqlite.prepare(
			"SELECT count(*) AS n FROM campaign_event_secrets WHERE event_id IN (SELECT id FROM campaign_events WHERE session_id = 'session-h')"
		).get() as { n: number }).n;
		expect(secretsBefore).toBeGreaterThan(0);

		const ended = await endSession({ dbContext: ctx, campaignId, sessionId: 'session-h', actorUserId: GM, now: new Date(300_000) });
		if (!ended.ok) throw new Error('fixture: end failed');
		return { publicCanary, privateHandCanary, preparedCanary, serverOrderCanary, checksum: ended.publicHistoryChecksum };
	}

	it('keeps public history and purges every private and server secret', async () => {
		const { publicCanary, privateHandCanary, preparedCanary, serverOrderCanary } = await buildAndEnd();

		const history = await loadCompletedSessionHistory(db, campaignId, 'session-h', PLAYER_B);
		expect(history).not.toBeNull();
		expect(history!.publicEvents.some((event) => event.kind === 'card-played')).toBe(true);

		const serialized = JSON.stringify(history);
		expect(serialized).toContain(publicCanary);
		expect(serialized).not.toContain(privateHandCanary);
		expect(serialized).not.toContain(preparedCanary);
		expect(serialized).not.toContain(serverOrderCanary);

		expect((sqlite.prepare("SELECT count(*) AS n FROM session_private_states WHERE session_id = 'session-h'").get() as { n: number }).n).toBe(0);
		expect(
			(sqlite.prepare(
				"SELECT count(*) AS n FROM campaign_event_secrets WHERE event_id IN (SELECT id FROM campaign_events WHERE session_id = 'session-h')"
			).get() as { n: number }).n
		).toBe(0);
		// The server fragment is emptied, not merely orphaned.
		expect(
			(sqlite.prepare("SELECT server_state_json FROM session_server_states WHERE session_id = 'session-h'").get() as {
				server_state_json: string;
			}).server_state_json
		).toBe('{}');
	});

	it('the checksum changes when ordered public history is altered — corruption detection, not a signature', async () => {
		const { checksum } = await buildAndEnd();
		const history = (await loadCompletedSessionHistory(db, campaignId, 'session-h', GM))!;

		// The digest covers the ordered public events up to the end; the terminal
		// `session-ended` event CARRIES the checksum and so cannot be inside it.
		const covered = history.publicEvents.filter((event) => event.kind !== 'session-ended');
		const recomputed = canonicalDigest({ events: covered, finalPublicState: history.finalPublicState });
		expect(recomputed).toBe(checksum);

		// Drop one event: the digest no longer matches. That is the whole
		// guarantee — a client can detect accidental corruption; a database
		// that can rewrite events can restamp the checksum too.
		const tampered = canonicalDigest({ events: covered.slice(1), finalPublicState: history.finalPublicState });
		expect(tampered).not.toBe(checksum);
	});

	it('lists completed sessions for the GM and current members only', async () => {
		await buildAndEnd();

		expect(await listCompletedSessions(db, campaignId, GM)).toHaveLength(1);
		expect(await listCompletedSessions(db, campaignId, PLAYER_A)).toHaveLength(1);
		// A non-member sees nothing — not an empty list, a null the route 404s.
		expect(await listCompletedSessions(db, campaignId, 'stranger')).toBeNull();
	});

	it('a removed member loses history access', async () => {
		await buildAndEnd();
		sqlite.prepare('DELETE FROM campaign_members WHERE campaign_id = ? AND user_id = ?').run(campaignId, PLAYER_B);

		expect(await listCompletedSessions(db, campaignId, PLAYER_B)).toBeNull();
		expect(await loadCompletedSessionHistory(db, campaignId, 'session-h', PLAYER_B)).toBeNull();
	});

	it('an open session has no history page', async () => {
		expect(await loadCompletedSessionHistory(db, campaignId, 'session-h', GM)).toBeNull();
	});

	it('a session outside the campaign is indistinguishable from none', async () => {
		await buildAndEnd();

		expect(await loadCompletedSessionHistory(db, 'campaign-other', 'session-h', GM)).toBeNull();
	});
});
