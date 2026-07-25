/**
 * Increment 4 Task 2 — the guided test of fate through its own command service.
 *
 * The contract this file pins down, on top of the pure engine tests:
 *
 * - The tested attribute and the actor's Resolve are read from the SHEET on
 *   every command. A client cannot supply either (the envelope is `.strict()`),
 *   and a sheet edit between commands is visible to the next one.
 * - Buying favor is one atomic unit with the command that bought it: the
 *   character's Resolve write, the session version claim, the fragments, and the
 *   events all commit together or not at all.
 * - A Resolve value that moved before the purchase arrived is refused with the
 *   current numbers and persists NOTHING — no command row, no version bump — so
 *   the reconfirmed retry may reuse the same commandId.
 * - A test of fate survives a full persistence round trip mid-flight, which the
 *   pure engine tests cannot see.
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as schema from '$lib/server/db/schema';
import type { AppDb } from '$lib/server/db';
import type { AppDbContext } from '$lib/server/db/atomic';
import { createBlankCharacter, type GuildBookCharacterData } from '$lib/types/character';
import { attachAdventurer } from '$lib/server/campaign/tenure';
import { saveWholeCharacter } from '$lib/server/character/versioned-write';
import { startSession } from '$lib/server/session/lifecycle';
import { executeGuidedTestCommand } from '$lib/server/session/guided-test-command-service';
import { loadGuidedTestMaterials } from '$lib/server/session/guided-test-materials';

const GM_USER = 'gm-a';
const PLAYER_A = 'player-a';
const PLAYER_B = 'player-b';

describe('guided test of fate — through the command service', () => {
	let sqlite: Database.Database;
	let ctx: AppDbContext;
	let db: AppDb;

	beforeEach(async () => {
		sqlite = new Database(':memory:');
		sqlite.pragma('foreign_keys = ON');
		applyMigrations(sqlite);
		ctx = { kind: 'sqlite', db: drizzle(sqlite, { schema }), raw: sqlite };
		db = ctx.db as unknown as AppDb;
		await seedTable();
		const started = await startSession({
			dbContext: ctx,
			campaignId: 'campaign-a',
			actorUserId: GM_USER,
			sessionId: 'session-a',
			shuffleSeed: 'guided-test-seed',
			now: new Date(200_000)
		});
		if (!started.ok) throw new Error('fixture: session failed to start');
	});

	afterEach(() => sqlite.close());

	/** Two attached adventurers: Alice at Swords 4 with 3 Resolve, Bob at
	 * Swords 1 with 0 Resolve. */
	async function seedTable(): Promise<void> {
		seedUsersAndCampaign(sqlite, [GM_USER, PLAYER_A, PLAYER_B]);
		seedMembership(sqlite, 'membership-a', PLAYER_A);
		seedMembership(sqlite, 'membership-b', PLAYER_B);

		seedCharacter(sqlite, 'character-a', PLAYER_A, (data) => {
			data.resolve = { current: 3, max: 4 };
			data.attributes.swords = { value: 4, sources: [] };
			data.attributes.cups = { value: 2, sources: [] };
		});
		seedCharacter(sqlite, 'character-b', PLAYER_B, (data) => {
			data.resolve = { current: 0, max: 4 };
			data.attributes.swords = { value: 1, sources: [] };
			data.attributes.cups = { value: 1, sources: [] };
		});

		for (const [membershipId, userId, characterId, tenureId, at] of [
			['membership-a', PLAYER_A, 'character-a', 'tenure-a', 150_000],
			['membership-b', PLAYER_B, 'character-b', 'tenure-b', 151_000]
		] as const) {
			const attached = await attachAdventurer(db, {
				campaignId: 'campaign-a',
				membershipId,
				actorUserId: userId,
				characterId,
				tenureId,
				now: new Date(at)
			});
			if (!attached.ok) throw new Error(`fixture: attach ${tenureId} failed`);
		}
	}

	function readCharacterRow(characterId = 'character-a'): { version: number; data: string } {
		return sqlite.prepare('SELECT version, data FROM characters WHERE id = ?').get(characterId) as {
			version: number;
			data: string;
		};
	}

	function readCharacterData(characterId = 'character-a'): GuildBookCharacterData {
		return JSON.parse(readCharacterRow(characterId).data) as GuildBookCharacterData;
	}

	function sessionVersion(): number {
		return (sqlite.prepare("SELECT version FROM play_sessions WHERE id = 'session-a'").get() as { version: number }).version;
	}

	function commandRowCount(): number {
		return (sqlite.prepare("SELECT count(*) AS n FROM session_commands WHERE session_id = 'session-a'").get() as { n: number }).n;
	}

	async function execute(actorUserId: string, body: Record<string, unknown>) {
		return executeGuidedTestCommand({ dbContext: ctx, campaignId: 'campaign-a', sessionId: 'session-a', actorUserId, envelope: body });
	}

	/** GM declares Alice testing Swords, then settles favor. Returns the session
	 * version after both commands. */
	async function declareAndSettleFavor(): Promise<number> {
		const declared = await execute(GM_USER, {
			commandId: 'declare-1',
			observedSessionVersion: sessionVersion(),
			command: { type: 'declare-test-of-fate', actorTenureId: 'tenure-a', testedSuit: 'swords' }
		});
		expect(declared.outcome).toMatchObject({ ok: true });

		const settled = await execute(GM_USER, {
			commandId: 'favor-1',
			observedSessionVersion: sessionVersion(),
			command: { type: 'set-test-favor', favor: false, disfavor: false }
		});
		expect(settled.outcome).toMatchObject({ ok: true });
		return sessionVersion();
	}

	it('reads attributes and Resolve from the stored sheets', async () => {
		const materials = await loadGuidedTestMaterials(db, 'campaign-a');

		expect(materials.actors).toEqual([
			expect.objectContaining({
				tenureId: 'tenure-a',
				characterId: 'character-a',
				userId: PLAYER_A,
				attributes: expect.objectContaining({ swords: 4, cups: 2 }),
				resolveCurrent: 3,
				rosterOrder: 0
			}),
			expect.objectContaining({ tenureId: 'tenure-b', resolveCurrent: 0, rosterOrder: 1 })
		]);
	});

	it('excludes a dead adventurer from the eligible actors', async () => {
		sqlite.prepare("UPDATE characters SET life_status = 'dead' WHERE id = 'character-b'").run();

		const materials = await loadGuidedTestMaterials(db, 'campaign-a');

		expect(materials.actors.map((actor) => actor.tenureId)).toEqual(['tenure-a']);
	});

	it('carries a declared test through persistence and back into the projection', async () => {
		await declareAndSettleFavor();

		const reloaded = await execute(PLAYER_A, {
			commandId: 'draw-1',
			observedSessionVersion: sessionVersion(),
			command: { type: 'draw-test-card' }
		});

		expect(reloaded.outcome).toMatchObject({ ok: true });
		// The stage machine survived two intervening commits, so the draw resolved
		// against the declared suit and Alice's real Swords value.
		expect(reloaded.guidedTestProjection?.test).toMatchObject({
			actorTenureId: 'tenure-a',
			testedSuit: 'swords',
			result: expect.objectContaining({ modifier: 0 })
		});
		expect(reloaded.guidedTestProjection?.test?.result?.total).toBeGreaterThanOrEqual(4);
	});

	it('commits the Resolve spend and the session command as one unit', async () => {
		await declareAndSettleFavor();
		const versionBefore = sessionVersion();

		const result = await execute(PLAYER_A, {
			commandId: 'buy-1',
			observedSessionVersion: versionBefore,
			observedCharacterVersion: 1,
			expectedResolveCurrent: 3,
			command: { type: 'purchase-test-favor' }
		});

		expect(result.outcome).toMatchObject({ ok: true });
		expect(readCharacterData().resolve).toEqual({ current: 2, max: 4 });
		expect(readCharacterRow().version).toBe(2);
		expect(sessionVersion()).toBe(versionBefore + 1);
		expect(result.guidedTestProjection?.test).toMatchObject({ resolveSpent: true, resolveCurrent: 2 });

		const claims = sqlite
			.prepare('SELECT resulting_version, mutation_kind FROM character_version_claims WHERE character_id = ? ORDER BY resulting_version')
			.all('character-a') as Array<{ resulting_version: number; mutation_kind: string }>;
		expect(claims.at(-1)).toEqual({ resulting_version: 2, mutation_kind: 'session-resolve' });
	});

	it('applies the purchased favor to the drawn result', async () => {
		await declareAndSettleFavor();
		await execute(PLAYER_A, {
			commandId: 'buy-1',
			observedSessionVersion: sessionVersion(),
			observedCharacterVersion: 1,
			expectedResolveCurrent: 3,
			command: { type: 'purchase-test-favor' }
		});

		const drawn = await execute(PLAYER_A, {
			commandId: 'draw-1',
			observedSessionVersion: sessionVersion(),
			command: { type: 'draw-test-card' }
		});

		expect(drawn.guidedTestProjection?.test?.result).toMatchObject({
			modifier: 3,
			favorSources: ['resolve']
		});
	});

	it('refuses, and persists nothing, when Resolve moved before the purchase arrived', async () => {
		await declareAndSettleFavor();
		const versionBefore = sessionVersion();
		const commandsBefore = commandRowCount();

		const saved = await saveWholeCharacter(db, {
			characterId: 'character-a',
			ownerUserId: PLAYER_A,
			actorUserId: PLAYER_A,
			expectedVersion: 1,
			data: { ...readCharacterData(), resolve: { current: 1, max: 4 } }
		});
		if (!saved.ok) throw new Error('fixture: competing spend failed');

		const result = await execute(PLAYER_A, {
			commandId: 'buy-1',
			observedSessionVersion: versionBefore,
			observedCharacterVersion: 1,
			expectedResolveCurrent: 3,
			command: { type: 'purchase-test-favor' }
		});

		expect(result.outcome).toMatchObject({ ok: false, code: 'content-mismatch' });
		expect(result.outcome).toMatchObject({ message: expect.stringContaining('Resolve is now 1') });
		// No command row, no session bump — so the reconfirmed retry may reuse
		// this commandId rather than replaying a stored refusal.
		expect(commandRowCount()).toBe(commandsBefore);
		expect(sessionVersion()).toBe(versionBefore);
		expect(readCharacterData().resolve).toEqual({ current: 1, max: 4 });
	});

	it('preserves an unrelated sheet edit that moved the version', async () => {
		await declareAndSettleFavor();

		const saved = await saveWholeCharacter(db, {
			characterId: 'character-a',
			ownerUserId: PLAYER_A,
			actorUserId: PLAYER_A,
			expectedVersion: 1,
			data: { ...readCharacterData(), appearance: 'a new scar' }
		});
		if (!saved.ok) throw new Error('fixture: unrelated edit failed');

		// The client still reports the version it observed BEFORE that edit.
		const result = await execute(PLAYER_A, {
			commandId: 'buy-1',
			observedSessionVersion: sessionVersion(),
			observedCharacterVersion: 1,
			expectedResolveCurrent: 3,
			command: { type: 'purchase-test-favor' }
		});

		expect(result.outcome).toMatchObject({ ok: true });
		const after = readCharacterData();
		expect(after.resolve).toEqual({ current: 2, max: 4 });
		expect(after.appearance).toBe('a new scar');
	});

	it('refuses a purchase from an adventurer who cannot afford it', async () => {
		const declared = await execute(GM_USER, {
			commandId: 'declare-1',
			observedSessionVersion: sessionVersion(),
			command: { type: 'declare-test-of-fate', actorTenureId: 'tenure-b', testedSuit: 'swords' }
		});
		expect(declared.outcome).toMatchObject({ ok: true });
		await execute(GM_USER, {
			commandId: 'favor-1',
			observedSessionVersion: sessionVersion(),
			command: { type: 'set-test-favor', favor: false, disfavor: false }
		});

		const result = await execute(PLAYER_B, {
			commandId: 'buy-1',
			observedSessionVersion: sessionVersion(),
			observedCharacterVersion: 1,
			expectedResolveCurrent: 0,
			command: { type: 'purchase-test-favor' }
		});

		expect(result.outcome).toMatchObject({ ok: false });
		expect(readCharacterData('character-b').resolve).toEqual({ current: 0, max: 4 });
	});

	it('rejects the reconfirmation pair on a command that does not spend Resolve', async () => {
		const result = await execute(GM_USER, {
			commandId: 'declare-1',
			observedSessionVersion: sessionVersion(),
			observedCharacterVersion: 1,
			expectedResolveCurrent: 3,
			command: { type: 'declare-test-of-fate', actorTenureId: 'tenure-a', testedSuit: 'swords' }
		});

		expect(result.outcome).toMatchObject({ ok: false, code: 'illegal-command' });
		expect(commandRowCount()).toBe(0);
		expect(readCharacterRow().version).toBe(1);
	});

	it('rejects a purchase that omits the reconfirmation pair', async () => {
		await declareAndSettleFavor();

		const result = await execute(PLAYER_A, {
			commandId: 'buy-1',
			observedSessionVersion: sessionVersion(),
			command: { type: 'purchase-test-favor' }
		});

		expect(result.outcome).toMatchObject({ ok: false, code: 'illegal-command' });
		expect(readCharacterRow().version).toBe(1);
	});

	it('rejects an envelope carrying a character document', async () => {
		const result = await execute(GM_USER, {
			commandId: 'declare-1',
			observedSessionVersion: sessionVersion(),
			command: { type: 'declare-test-of-fate', actorTenureId: 'tenure-a', testedSuit: 'swords' },
			characterData: createBlankCharacter()
		});

		expect(result.outcome).toEqual({ ok: false, code: 'illegal-command', message: 'malformed command envelope' });
	});

	it('rejects an envelope carrying a client-supplied attribute', async () => {
		const result = await execute(GM_USER, {
			commandId: 'declare-1',
			observedSessionVersion: sessionVersion(),
			command: { type: 'declare-test-of-fate', actorTenureId: 'tenure-a', testedSuit: 'swords', attribute: 99 }
		});

		expect(result.outcome).toEqual({ ok: false, code: 'illegal-command', message: 'malformed command envelope' });
	});

	it('refuses a player driving another adventurer’s test', async () => {
		await declareAndSettleFavor();

		const result = await execute(PLAYER_B, {
			commandId: 'draw-1',
			observedSessionVersion: sessionVersion(),
			command: { type: 'draw-test-card' }
		});

		expect(result.outcome).toMatchObject({ ok: false });
	});

	it('replays an accepted command rather than drawing twice for one commandId', async () => {
		await declareAndSettleFavor();
		const body = { commandId: 'draw-1', observedSessionVersion: sessionVersion(), command: { type: 'draw-test-card' } };

		const first = await execute(PLAYER_A, body);
		const versionAfterFirst = sessionVersion();
		const second = await execute(PLAYER_A, body);

		expect(first.outcome).toMatchObject({ ok: true });
		expect(second.outcome).toEqual(first.outcome);
		expect(sessionVersion()).toBe(versionAfterFirst);
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

function seedUsersAndCampaign(sqlite: Database.Database, userIds: string[]): void {
	for (const userId of userIds) {
		sqlite.prepare('INSERT INTO users (id) VALUES (?)').run(userId);
	}
	sqlite
		.prepare('INSERT INTO campaigns (id, owner_user_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
		.run('campaign-a', GM_USER, 'The Lantern Guild', '', 100, 100);
}

function seedMembership(sqlite: Database.Database, membershipId: string, userId: string): void {
	sqlite
		.prepare('INSERT INTO campaign_members (id, campaign_id, user_id, joined_at) VALUES (?, ?, ?, ?)')
		.run(membershipId, 'campaign-a', userId, 100);
}

function seedCharacter(
	sqlite: Database.Database,
	characterId: string,
	userId: string,
	mutate: (data: GuildBookCharacterData) => void = () => {}
): void {
	const character = createBlankCharacter();
	character.name = characterId;
	character.isDraft = false;
	mutate(character);
	sqlite
		.prepare(
			`INSERT INTO characters
			(id, user_id, name, data, version, life_status, is_draft, is_archived, created_at, updated_at)
			VALUES (?, ?, ?, ?, 1, 'alive', 0, 0, 100, 100)`
		)
		.run(characterId, userId, character.name, JSON.stringify(character));
	sqlite
		.prepare(
			`INSERT INTO character_version_claims (character_id, resulting_version, mutation_kind, actor_user_id, created_at)
			VALUES (?, 1, 'create', ?, 100)`
		)
		.run(characterId, userId);
}
