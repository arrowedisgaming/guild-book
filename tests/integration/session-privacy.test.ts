import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyMigrations, fakeEvent, makeDbContext, seedCampaignFoundation } from '../fixtures/session-http';
import { resetCursorHintsForTest } from '$lib/server/session/latest-cursor';
import type { AppDbContext } from '$lib/server/db/atomic';

/**
 * TDD Step 1 (task-6-brief): the canary test, written BEFORE any Task 6
 * route existed, against a poisoned fixture runtime. Two unique secret
 * identities — never present in real content — are compiled into the
 * session's pinned runtime by mocking `$lib/server/content/loader`'s
 * `getContentPack` (the only override hook `startSession`
 * (`$lib/server/session/lifecycle.ts`) actually reads):
 *
 * - `SECRET_PLAYER_A_CUPS_I_7f02` — the label of card `cups-i`, planted
 *   into player-a's own private hand.
 * - `SECRET_GM_MAGICIAN_9c31` — the label/major-name of card `magician`,
 *   planted into the GM's private hand.
 *
 * Poisoning rank `i`'s label (rather than the card `id`) affects every
 * suit's Ace identically (`swords-i`/`wands-i`/`pentacles-i` too) — the
 * schema has no per-suit-rank label. To keep the canary unambiguous, this
 * suite never issues a player-deck draw (which could randomly surface one of
 * those siblings); the only live command exercised is the GM's major-deck
 * draw, which can never re-draw `magician` (already moved out of the draw
 * pile below).
 *
 * Every real Task 5 service (`command-service.ts`/`lifecycle.ts`/
 * `repository.ts`) runs unmocked against a real SQLite DB; only
 * authentication (`ensureUser`) is mocked, exactly like `ensureUser` is
 * mocked in `tests/unit/campaign-access.test.ts` — Increment 1's own
 * membership/role resolution runs for real underneath it.
 */

const PLAYER_A_SECRET = 'SECRET_PLAYER_A_CUPS_I_7f02';
const GM_SECRET = 'SECRET_GM_MAGICIAN_9c31';
const POISON_STRINGS = [PLAYER_A_SECRET, GM_SECRET];

const mocks = vi.hoisted(() => ({
	ensureUser: vi.fn(),
	getEnv: vi.fn((event: { platform?: { env?: Record<string, string> } }, key: string) => event.platform?.env?.[key]),
	getDb: vi.fn(),
	getDbContext: vi.fn()
}));

vi.mock('$lib/server/auth', () => ({ ensureUser: mocks.ensureUser, getEnv: mocks.getEnv }));
vi.mock('$lib/server/db', () => ({ getDb: mocks.getDb, getDbContext: mocks.getDbContext }));

vi.mock('$lib/server/content/loader', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/content/loader')>();
	const pack = actual.getContentPack();
	const poisoned = structuredClone(pack) as typeof pack;

	const aceRank = poisoned.tarot.ranks.find((rank) => rank.id === 'i');
	if (!aceRank) throw new Error('fixture setup: rank "i" not found in bundled tarot config');
	aceRank.label = 'SECRET_PLAYER_A_CUPS_I_7f02';

	const magician = poisoned.tarot.majorArcana.find((card) => card.id === 'magician');
	if (!magician) throw new Error('fixture setup: major arcana "magician" not found in bundled tarot config');
	magician.name = 'SECRET_GM_MAGICIAN_9c31';

	return { ...actual, getContentPack: () => poisoned };
});

import { GET as getSessions, POST as postSessions } from '../../src/routes/api/campaigns/[id]/sessions/+server';
import { GET as getSession, PATCH as patchSession } from '../../src/routes/api/campaigns/[id]/sessions/[sessionId]/+server';
import { POST as postCommand } from '../../src/routes/api/campaigns/[id]/sessions/[sessionId]/commands/+server';
import { GET as getSync } from '../../src/routes/api/campaigns/[id]/sync/+server';

describe('session HTTP surface — privacy canary', () => {
	let sqlite: Database.Database;
	let dbContext: AppDbContext;
	let campaignId: string;
	let gmUserId: string;
	let playerAUserId: string;
	let playerBUserId: string;
	let sessionId: string;
	let consoleLogSpy: ReturnType<typeof vi.spyOn>;
	let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		vi.clearAllMocks();
		// See the matching comment in `session-api.test.ts` — the isolate-local
		// cursor-hint `Map` is a module singleton; without resetting it here a
		// hint left by an earlier test could mask a real /sync regression
		// behind a stale 204 rather than a genuine "nothing changed".
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

		consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		mocks.ensureUser.mockResolvedValue(gmUserId);
		const started = await postSessions(fakeEvent({ method: 'POST', campaignId }) as never);
		expect(started.status).toBe(201);
		sessionId = ((await started.json()) as { sessionId: string }).sessionId;

		plantPoisonedCards(sqlite, sessionId, gmUserId, playerAUserId);
	});

	afterEach(() => {
		consoleLogSpy.mockRestore();
		consoleWarnSpy.mockRestore();
		consoleErrorSpy.mockRestore();
		sqlite.close();
	});

	it("player-a's own read carries their secret and never the GM's — in the body, never in headers", async () => {
		mocks.ensureUser.mockResolvedValue(playerAUserId);
		const response = await getSession(fakeEvent({ campaignId, sessionId }) as never);
		expect(response.status).toBe(200);
		const bodyText = JSON.stringify(await response.json());

		expect(bodyText).toContain(PLAYER_A_SECRET);
		expect(bodyText).not.toContain(GM_SECRET);
		// Headers must never carry a secret at all, even the owner's own —
		// there's no legitimate reason a card identity would ever need to
		// travel in a response header.
		assertNoPoisonInHeaders(response, "player-a's own session read headers");
	});

	it("the GM's own read carries their secret and never player-a's — in the body, never in headers", async () => {
		mocks.ensureUser.mockResolvedValue(gmUserId);
		const response = await getSession(fakeEvent({ campaignId, sessionId }) as never);
		expect(response.status).toBe(200);
		const bodyText = JSON.stringify(await response.json());

		expect(bodyText).toContain(GM_SECRET);
		expect(bodyText).not.toContain(PLAYER_A_SECRET);
		assertNoPoisonInHeaders(response, "the GM's own session read headers");
	});

	it('an uninvolved player never sees either secret, across the session read, the sync poll, and headers', async () => {
		mocks.ensureUser.mockResolvedValue(playerBUserId);

		const sessionResponse = await getSession(fakeEvent({ campaignId, sessionId }) as never);
		const sessionBody = JSON.stringify(await sessionResponse.json());
		assertNoPoison(sessionBody, 'player-b session read body');
		assertNoPoisonInHeaders(sessionResponse, 'player-b session read headers');

		const syncResponse = await getSync(
			fakeEvent({ campaignId, searchParams: { after: '0', version: '0' } }) as never
		);
		expect(syncResponse.status).toBe(200);
		const syncBody = JSON.stringify(await syncResponse.json());
		assertNoPoison(syncBody, 'player-b sync body');
		assertNoPoisonInHeaders(syncResponse, 'player-b sync headers');
	});

	it('a card-secret-bearing event flows through /sync — player-a sees it, player-b never does (review round 1)', async () => {
		// A real private-zone-to-private-zone move (hand -> facedown, both
		// owned by player-a) so the resulting event's identity lands only in
		// `privatePayloads[player-a]` (`card-commands.ts`'s `buildMoveEvent`) —
		// never the public payload. `cups-i` is the poisoned card already
		// planted in player-a's hand by `plantPoisonedCards`.
		mocks.ensureUser.mockResolvedValue(playerAUserId);
		const moveResponse = await postCommand(
			fakeEvent({
				method: 'POST',
				campaignId,
				sessionId,
				body: {
					commandId: 'facedown-1',
					observedSessionVersion: 1,
					command: {
						type: 'place-facedown',
						sourceZoneId: `hand:${playerAUserId}`,
						cardId: 'cups-i',
						destinationZoneId: `facedown:${playerAUserId}`
					}
				}
			}) as never
		);
		expect(moveResponse.status).toBe(200);
		expect(((await moveResponse.json()) as { outcome: { ok: boolean } }).outcome.ok).toBe(true);

		// Player-a's own poll: the event itself carries their own private
		// payload (the raw card id), and their session projection carries the
		// poisoned label.
		const playerASync = await getSync(fakeEvent({ campaignId, searchParams: { after: '0', version: '1' } }) as never);
		expect(playerASync.status).toBe(200);
		const playerASyncBody = (await playerASync.json()) as {
			events: Array<{ kind: string; privatePayload?: { cardIds?: string[] } }>;
			session: { projection: unknown } | null;
		};
		const playerAEvent = playerASyncBody.events.find((event) => event.kind === 'card-placed-facedown');
		expect(playerAEvent?.privatePayload?.cardIds).toEqual(['cups-i']);
		expect(JSON.stringify(playerASyncBody.session?.projection)).toContain(PLAYER_A_SECRET);
		assertNoPoisonInHeaders(playerASync, "player-a's sync headers");

		// Player-b's poll of the SAME event range: no private payload at all
		// (`listEventSecretsForRecipient` is scoped to player-b, who owns no
		// secret row for this event), and neither the raw card id nor the
		// poisoned label anywhere in the response.
		mocks.ensureUser.mockResolvedValue(playerBUserId);
		const playerBSync = await getSync(fakeEvent({ campaignId, searchParams: { after: '0', version: '1' } }) as never);
		expect(playerBSync.status).toBe(200);
		const playerBBody = (await playerBSync.json()) as { events: Array<{ kind: string; privatePayload?: unknown }> };
		const playerBEvent = playerBBody.events.find((event) => event.kind === 'card-placed-facedown');
		expect(playerBEvent).toBeDefined();
		expect(playerBEvent?.privatePayload).toBeUndefined();
		const playerBBodyText = JSON.stringify(playerBBody);
		expect(playerBBodyText).not.toContain('cups-i');
		assertNoPoison(playerBBodyText, "player-b's sync poll after player-a's private move");
		assertNoPoisonInHeaders(playerBSync, "player-b's sync poll headers");
	});

	it('a nonmember gets an indistinguishable 404 with no secret in the thrown error', async () => {
		mocks.ensureUser.mockResolvedValue('stranger');
		let caught: unknown;
		try {
			await getSession(fakeEvent({ campaignId, sessionId }) as never);
		} catch (thrown) {
			caught = thrown;
		}
		expect(caught).toMatchObject({ status: 404 });
		assertNoPoison(JSON.stringify(caught), 'nonmember thrown error');
	});

	it('the session LIST endpoint (coarse summary) never carries either secret', async () => {
		mocks.ensureUser.mockResolvedValue(playerAUserId);
		const response = await getSessions(fakeEvent({ campaignId }) as never);
		assertNoPoison(JSON.stringify(await response.json()), 'sessions list body');
	});

	it("a command executed by an uninvolved actor returns only that actor's own outcome — never a secret from either owner", async () => {
		mocks.ensureUser.mockResolvedValue(gmUserId);
		const response = await postCommand(
			fakeEvent({
				method: 'POST',
				campaignId,
				sessionId,
				body: {
					commandId: 'gm-draws-major',
					observedSessionVersion: 1,
					command: { type: 'draw', deck: 'major', destinationZoneId: 'gmHand', count: 1 }
				}
			}) as never
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { outcome: { ok: boolean }; projection: unknown };
		expect(body.outcome.ok).toBe(true);
		// The GM's own response legitimately contains their own secret; the
		// cross-role guarantee under test is that it never contains player-a's.
		expect(JSON.stringify(body.projection)).not.toContain(PLAYER_A_SECRET);

		// The resulting public campaign_events row — read straight from the DB,
		// not through any route — must never carry either identity: a 'draw'
		// event's public payload is card-blind by construction (card-commands.ts).
		const publicRows = sqlite
			.prepare('SELECT public_payload_json AS json FROM campaign_events WHERE session_id = ?')
			.all(sessionId) as Array<{ json: string }>;
		for (const row of publicRows) assertNoPoison(row.json, 'public campaign_events row');
	});

	it('ending the session stamps a public history snapshot with neither secret, and the count-only public projection stays clean', async () => {
		mocks.ensureUser.mockResolvedValue(gmUserId);
		const response = await patchSession(
			fakeEvent({ method: 'PATCH', campaignId, sessionId, body: { action: 'end' } }) as never
		);
		expect(response.status).toBe(200);
		assertNoPoison(JSON.stringify(await response.json()), 'end-session response body');

		const row = sqlite
			.prepare('SELECT final_public_state_json AS json FROM play_sessions WHERE id = ?')
			.get(sessionId) as { json: string };
		assertNoPoison(row.json, 'final_public_state_json');

		// Reading the now-ended session's history is public by construction —
		// confirm no secret survived into it either.
		mocks.ensureUser.mockResolvedValue(playerBUserId);
		const historyResponse = await getSession(fakeEvent({ campaignId, sessionId }) as never);
		assertNoPoison(JSON.stringify(await historyResponse.json()), 'ended session history body');
	});

	it('never logs either secret to the console across the whole scenario above', async () => {
		mocks.ensureUser.mockResolvedValue(playerAUserId);
		await getSession(fakeEvent({ campaignId, sessionId }) as never);
		mocks.ensureUser.mockResolvedValue(gmUserId);
		await getSession(fakeEvent({ campaignId, sessionId }) as never);
		mocks.ensureUser.mockResolvedValue(playerBUserId);
		await getSync(fakeEvent({ campaignId, searchParams: { after: '0', version: '0' } }) as never);

		const allCalls = [...consoleLogSpy.mock.calls, ...consoleWarnSpy.mock.calls, ...consoleErrorSpy.mock.calls];
		const serialized = JSON.stringify(allCalls);
		assertNoPoison(serialized, 'captured console output');
	});
});

function assertNoPoison(haystack: string, label: string): void {
	for (const secret of POISON_STRINGS) {
		expect(haystack, `${label} must not contain ${secret}`).not.toContain(secret);
	}
}

function assertNoPoisonInHeaders(response: Response, label: string): void {
	const serialized = JSON.stringify([...response.headers.entries()]);
	assertNoPoison(serialized, label);
}

/**
 * Moves `cups-i` out of the server-only player draw pile into player-a's
 * private hand, and `magician` out of the server-only major draw pile into
 * the GM's private hand — direct SQL, bypassing the command service
 * entirely (this suite only ever reads/lifecycle-transitions afterward, so
 * the reducer's whole-state invariant check, which only runs inside
 * `reduceSession`, never re-examines this edit). Cards are MOVED, not
 * duplicated, so "every configured card lives in exactly one zone" still
 * holds for the one live command this suite does execute (the GM's
 * major-deck draw).
 */
function plantPoisonedCards(sqlite: Database.Database, sessionId: string, gmUserId: string, playerAUserId: string): void {
	const serverRow = sqlite.prepare('SELECT server_state_json AS json FROM session_server_states WHERE session_id = ?').get(sessionId) as {
		json: string;
	};
	const server = JSON.parse(serverRow.json) as { playerDraw: string[]; majorDraw: string[] };
	if (!server.playerDraw.includes('cups-i')) throw new Error('fixture setup: cups-i not in playerDraw');
	if (!server.majorDraw.includes('magician')) throw new Error('fixture setup: magician not in majorDraw');
	server.playerDraw = server.playerDraw.filter((id) => id !== 'cups-i');
	server.majorDraw = server.majorDraw.filter((id) => id !== 'magician');
	sqlite.prepare('UPDATE session_server_states SET server_state_json = ? WHERE session_id = ?').run(JSON.stringify(server), sessionId);

	const playerARow = sqlite
		.prepare('SELECT private_state_json AS json FROM session_private_states WHERE session_id = ? AND recipient_user_id = ?')
		.get(sessionId, playerAUserId) as { json: string };
	const playerAFragment = JSON.parse(playerARow.json) as { zones: Array<{ id: string; cards: string[] }> };
	const hand = playerAFragment.zones.find((zone) => zone.id === `hand:${playerAUserId}`);
	if (!hand) throw new Error('fixture setup: player-a hand zone not found');
	hand.cards.push('cups-i');
	sqlite
		.prepare('UPDATE session_private_states SET private_state_json = ? WHERE session_id = ? AND recipient_user_id = ?')
		.run(JSON.stringify(playerAFragment), sessionId, playerAUserId);

	const gmRow = sqlite
		.prepare('SELECT private_state_json AS json FROM session_private_states WHERE session_id = ? AND recipient_user_id = ?')
		.get(sessionId, gmUserId) as { json: string };
	const gmFragment = JSON.parse(gmRow.json) as { gmHand?: string[] };
	gmFragment.gmHand = [...(gmFragment.gmHand ?? []), 'magician'];
	sqlite
		.prepare('UPDATE session_private_states SET private_state_json = ? WHERE session_id = ? AND recipient_user_id = ?')
		.run(JSON.stringify(gmFragment), sessionId, gmUserId);
}
