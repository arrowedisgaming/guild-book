/**
 * Increment 4 Task 6 — active-session departure cleanup, one service for both
 * paths.
 *
 * The contract: a player leaving (or the GM removing them) during an open
 * session is ONE atomic unit — membership revocation, living tenure end,
 * every privately-held card returning to its owning draw pile followed by an
 * authoritative shuffle, Challenge roster removal, the sanitized count-only
 * public event, and private-secret deletion. An injected failure in any
 * statement leaves original access and state intact. Archiving is refused
 * with an open (active or frozen) session.
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '$lib/server/db/schema';
import type { AppDb } from '$lib/server/db';
import type { AppDbContext } from '$lib/server/db/atomic';
import { applyMigrations, seedCampaignFoundation } from '../fixtures/session-http';
import { createBlankCharacter } from '$lib/types/character';
import { attachAdventurer } from '$lib/server/campaign/tenure';
import { startSession } from '$lib/server/session/lifecycle';
import { executeCommand } from '$lib/server/session/command-service';
import { resolveSessionActor } from '$lib/server/session/repository';
import { archiveCampaign } from '$lib/server/campaign/membership';
import {
	leaveCampaignWithCleanup,
	removeCampaignMemberWithCleanup,
	livePlaySessionStatePort
} from '$lib/server/session/member-cleanup';

const GM = 'gm-a';
const PLAYER_A = 'player-a';
const PLAYER_B = 'player-b';

describe('active-session member cleanup', () => {
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

		// Player A holds an attached adventurer (a live tenure to end).
		const character = createBlankCharacter();
		character.name = 'Departer';
		character.isDraft = false;
		sqlite
			.prepare(
				`INSERT INTO characters (id, user_id, name, data, version, life_status, is_draft, is_archived, created_at, updated_at)
				 VALUES ('char-a', ?, 'Departer', ?, 1, 'alive', 0, 0, 100, 100)`
			)
			.run(PLAYER_A, JSON.stringify(character));
		sqlite
			.prepare(
				`INSERT INTO character_version_claims (character_id, resulting_version, mutation_kind, actor_user_id, created_at)
				 VALUES ('char-a', 1, 'create', ?, 100)`
			)
			.run(PLAYER_A);
		const attached = await attachAdventurer(db, {
			campaignId,
			membershipId: `member-${PLAYER_A}`,
			actorUserId: PLAYER_A,
			characterId: 'char-a',
			tenureId: 'tenure-a',
			now: new Date(150_000)
		});
		if (!attached.ok) throw new Error('fixture: attach failed');

		const started = await startSession({
			dbContext: ctx,
			campaignId,
			actorUserId: GM,
			sessionId: 'session-c',
			shuffleSeed: 'cleanup-seed',
			now: new Date(200_000)
		});
		if (!started.ok) throw new Error('fixture: session failed to start');
	});

	afterEach(() => sqlite.close());

	async function command(actorUserId: string, commandId: string, body: Record<string, unknown>) {
		const version = (sqlite.prepare("SELECT version FROM play_sessions WHERE id = 'session-c'").get() as { version: number }).version;
		const result = await executeCommand({
			dbContext: ctx,
			campaignId,
			sessionId: 'session-c',
			actorUserId,
			envelope: { commandId, observedSessionVersion: version, command: body }
		});
		if (!result.outcome.ok) throw new Error(`fixture command rejected: ${JSON.stringify(result.outcome)}`);
	}

	function privateHand(userId: string): string[] {
		const row = sqlite
			.prepare('SELECT private_state_json FROM session_private_states WHERE session_id = ? AND recipient_user_id = ?')
			.get('session-c', userId) as { private_state_json: string } | undefined;
		if (!row) return [];
		const fragment = JSON.parse(row.private_state_json) as { zones: Array<{ id: string; cards: string[] }> };
		return fragment.zones.flatMap((zone) => zone.cards);
	}

	function drawPile(): string[] {
		const row = sqlite.prepare("SELECT server_state_json FROM session_server_states WHERE session_id = 'session-c'").get() as {
			server_state_json: string;
		};
		return (JSON.parse(row.server_state_json) as { playerDraw: string[] }).playerDraw;
	}

	it('a leave returns every private card to the draw pile, shuffled, and revokes everything atomically', async () => {
		await command(PLAYER_A, 'draw-1', { type: 'draw', deck: 'player', destinationZoneId: `hand:${PLAYER_A}`, count: 3 });
		const held = privateHand(PLAYER_A);
		expect(held).toHaveLength(3);
		const pileBefore = drawPile();
		expect(pileBefore).not.toEqual(expect.arrayContaining(held));

		const result = await leaveCampaignWithCleanup(db, { campaignId, membershipId: `member-${PLAYER_A}`, userId: PLAYER_A });
		expect(result).toMatchObject({ ok: true, sessionId: 'session-c', endedTenureId: 'tenure-a' });

		// Every held card is back in the pile, and the pile was SHUFFLED — the
		// returned cards are not simply appended at the end.
		const pileAfter = drawPile();
		expect(pileAfter).toEqual(expect.arrayContaining(held));
		expect(pileAfter.length).toBe(pileBefore.length + 3);
		expect(pileAfter.slice(-3).sort()).not.toEqual([...held].sort());

		// Membership revoked, tenure ended, private state and secrets gone.
		expect(
			(sqlite.prepare('SELECT left_at FROM campaign_members WHERE id = ?').get(`member-${PLAYER_A}`) as { left_at: number | null }).left_at
		).not.toBeNull();
		expect(
			(sqlite.prepare("SELECT ended_at FROM campaign_adventurer_tenures WHERE id = 'tenure-a'").get() as { ended_at: number | null }).ended_at
		).not.toBeNull();
		expect(privateHand(PLAYER_A)).toEqual([]);
		expect(
			(sqlite.prepare(
				"SELECT count(*) AS n FROM campaign_event_secrets WHERE recipient_user_id = ? AND event_id IN (SELECT id FROM campaign_events WHERE session_id = 'session-c')"
			).get(PLAYER_A) as { n: number }).n
		).toBe(0);

		// The sanitized public event names counts, never cards.
		const event = sqlite
			.prepare("SELECT public_payload_json FROM campaign_events WHERE kind = 'session-participant-removed'")
			.get() as { public_payload_json: string };
		expect(JSON.parse(event.public_payload_json)).toMatchObject({ reason: 'left', returnedCardCount: 3 });
		for (const cardId of held) expect(event.public_payload_json).not.toContain(cardId);

		// The departed member's next request is a flat denial at the access
		// layer: they no longer resolve to a session actor at all, which is what
		// every route turns into a 404 — and even if a stale client raced past
		// it, their private rows above are already gone.
		expect(await resolveSessionActor(db, campaignId, PLAYER_A)).toBeNull();
	});

	it('a GM removal runs the identical cleanup with reason "removed"', async () => {
		await command(PLAYER_A, 'draw-1', { type: 'draw', deck: 'player', destinationZoneId: `hand:${PLAYER_A}`, count: 2 });

		const result = await removeCampaignMemberWithCleanup(db, { campaignId, membershipId: `member-${PLAYER_A}`, ownerUserId: GM });
		expect(result).toMatchObject({ ok: true, sessionId: 'session-c' });

		const event = sqlite
			.prepare("SELECT public_payload_json FROM campaign_events WHERE kind = 'session-participant-removed'")
			.get() as { public_payload_json: string };
		expect(JSON.parse(event.public_payload_json)).toMatchObject({ reason: 'removed', returnedCardCount: 2 });
		expect(
			(sqlite.prepare('SELECT removed_at FROM campaign_members WHERE id = ?').get(`member-${PLAYER_A}`) as { removed_at: number | null })
				.removed_at
		).not.toBeNull();
	});

	it('an injected statement failure leaves membership, tenure, and session state intact', async () => {
		await command(PLAYER_A, 'draw-1', { type: 'draw', deck: 'player', destinationZoneId: `hand:${PLAYER_A}`, count: 2 });
		const heldBefore = privateHand(PLAYER_A);
		const versionBefore = (sqlite.prepare("SELECT version FROM play_sessions WHERE id = 'session-c'").get() as { version: number })
			.version;

		// Poison the batch: a trigger that aborts any UPDATE of the server state.
		sqlite.exec(
			`CREATE TRIGGER poison_cleanup BEFORE UPDATE ON session_server_states BEGIN SELECT RAISE(ABORT, 'injected'); END`
		);
		await expect(leaveCampaignWithCleanup(db, { campaignId, membershipId: `member-${PLAYER_A}`, userId: PLAYER_A })).rejects.toThrow();
		sqlite.exec('DROP TRIGGER poison_cleanup');

		// NOTHING moved: membership live, tenure live, hand intact, version same.
		expect(
			(sqlite.prepare('SELECT left_at FROM campaign_members WHERE id = ?').get(`member-${PLAYER_A}`) as { left_at: number | null }).left_at
		).toBeNull();
		expect(
			(sqlite.prepare("SELECT ended_at FROM campaign_adventurer_tenures WHERE id = 'tenure-a'").get() as { ended_at: number | null }).ended_at
		).toBeNull();
		expect(privateHand(PLAYER_A)).toEqual(heldBefore);
		expect((sqlite.prepare("SELECT version FROM play_sessions WHERE id = 'session-c'").get() as { version: number }).version).toBe(
			versionBefore
		);

		// And the departure still works once the fault clears.
		const retried = await leaveCampaignWithCleanup(db, { campaignId, membershipId: `member-${PLAYER_A}`, userId: PLAYER_A });
		expect(retried.ok).toBe(true);
	});

	it('archiving is refused while a session is open, and works after it ends', async () => {
		const refused = await archiveCampaign(db, { campaignId, ownerUserId: GM }, livePlaySessionStatePort(db));
		expect(refused).toEqual({ ok: false, reason: 'session-active' });

		// A frozen session still blocks it.
		sqlite.prepare("UPDATE play_sessions SET status = 'frozen' WHERE id = 'session-c'").run();
		expect(await archiveCampaign(db, { campaignId, ownerUserId: GM }, livePlaySessionStatePort(db))).toEqual({
			ok: false,
			reason: 'session-active'
		});

		sqlite.prepare("UPDATE play_sessions SET status = 'ended', ended_at = 400000 WHERE id = 'session-c'").run();
		expect(await archiveCampaign(db, { campaignId, ownerUserId: GM }, livePlaySessionStatePort(db))).toEqual({ ok: true });
	});

	it('a departure with no open session skips session cleanup entirely', async () => {
		sqlite.prepare("UPDATE play_sessions SET status = 'ended', ended_at = 400000 WHERE id = 'session-c'").run();

		const result = await leaveCampaignWithCleanup(db, { campaignId, membershipId: `member-${PLAYER_A}`, userId: PLAYER_A });

		expect(result.ok).toBe(true);
		expect((result as { sessionId?: string }).sessionId).toBeUndefined();
		expect(sqlite.prepare("SELECT count(*) AS n FROM campaign_events WHERE kind = 'session-participant-removed'").get()).toEqual({ n: 0 });
	});

	it('player B keeps their own private state across player A’s departure', async () => {
		await command(PLAYER_B, 'draw-b', { type: 'draw', deck: 'player', destinationZoneId: `hand:${PLAYER_B}`, count: 2 });
		const bHand = privateHand(PLAYER_B);

		await leaveCampaignWithCleanup(db, { campaignId, membershipId: `member-${PLAYER_A}`, userId: PLAYER_A });

		expect(privateHand(PLAYER_B)).toEqual(bHand);
		expect(await resolveSessionActor(db, campaignId, PLAYER_B)).not.toBeNull();
	});
});
