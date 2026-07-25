/**
 * Increment 4 Task 1: narrow, reconfirmable Resolve mutations.
 *
 * Spending Resolve for favor is the only character-resource mutation a session
 * command may cause, and it is deliberately the narrowest write in the app: it
 * rereads the current character document, changes ONLY `resolve.current`, and
 * commits under a conditional claim in the same atomic unit as the session
 * command. The contract this file pins down:
 *
 * - `expectedCharacterVersion` is ADVISORY. An unrelated sheet edit that moved
 *   the version but left Resolve alone must not block the spend, and must not
 *   be overwritten by it.
 * - `expectedResolveCurrent` is the HARD precondition. If Resolve itself moved,
 *   the spend is refused with the current numbers and the user must reconfirm —
 *   nothing is drawn, nothing is spent, no command row is accepted.
 * - The service never accepts a character document from a session command.
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
import { applyResolveIntent, type ResolveIntent } from '$lib/server/character/resource-write';
import { sessionCommandEnvelopeSchema } from '$lib/schemas/session.schema';
import { startSession } from '$lib/server/session/lifecycle';
import { executeCommand } from '$lib/server/session/command-service';

const GM_USER = 'gm-a';
const PLAYER_A = 'player-a';
const PLAYER_B = 'player-b';

describe('session Resolve spend — narrow versioned writes', () => {
	let sqlite: Database.Database;
	let ctx: AppDbContext;
	let db: AppDb;

	beforeEach(async () => {
		sqlite = new Database(':memory:');
		sqlite.pragma('foreign_keys = ON');
		applyMigrations(sqlite);
		ctx = { kind: 'sqlite', db: drizzle(sqlite, { schema }), raw: sqlite };
		db = ctx.db as unknown as AppDb;
		await seedAttachedPlayer();
	});

	afterEach(() => sqlite.close());

	/** campaign-a, one member, one finalized character at version 1 with a live
	 * tenure. Bumped to version 4 so the plan's own example numbers apply. */
	async function seedAttachedPlayer(): Promise<void> {
		seedUsersAndCampaign(sqlite, [GM_USER, PLAYER_A, PLAYER_B]);
		seedMembership(sqlite, 'membership-a', PLAYER_A);
		seedCharacter(sqlite, 'character-a', PLAYER_A, (data) => {
			data.resolve = { current: 3, max: 4 };
		});
		const attached = await attachAdventurer(db, {
			campaignId: 'campaign-a',
			membershipId: 'membership-a',
			actorUserId: PLAYER_A,
			characterId: 'character-a',
			tenureId: 'tenure-a',
			now: new Date(150_000)
		});
		if (!attached.ok) throw new Error('fixture: attach failed');
		// Three unrelated whole-sheet saves take the character to version 4.
		for (let version = 1; version <= 3; version++) {
			const saved = await saveWholeCharacter(db, {
				characterId: 'character-a',
				ownerUserId: PLAYER_A,
				actorUserId: PLAYER_A,
				expectedVersion: version,
				data: { ...readCharacterData(), appearance: `revision ${version}` }
			});
			if (!saved.ok) throw new Error(`fixture: save ${version} failed`);
		}
		expect(readCharacterRow().version).toBe(4);
	}

	function readCharacterRow(): { version: number; data: string } {
		return sqlite
			.prepare('SELECT version, data FROM characters WHERE id = ?')
			.get('character-a') as { version: number; data: string };
	}

	function readCharacterData(): GuildBookCharacterData {
		return JSON.parse(readCharacterRow().data) as GuildBookCharacterData;
	}

	function baseIntent(overrides: Partial<ResolveIntent> = {}): ResolveIntent {
		return {
			campaignId: 'campaign-a',
			sessionId: 'session-a',
			characterId: 'character-a',
			actorUserId: PLAYER_A,
			expectedCharacterVersion: 4,
			expectedResolveCurrent: 3,
			delta: -1,
			reason: 'test-favor',
			now: new Date(200_000),
			...overrides
		};
	}

	it('spends one Resolve, advancing the character version and touching nothing else', async () => {
		const before = readCharacterData();

		const result = await applyResolveIntent(ctx, baseIntent());

		expect(result).toMatchObject({ ok: true, version: 5, resolveCurrent: 2 });

		const after = readCharacterData();
		expect(after.resolve).toEqual({ current: 2, max: 4 });
		// Byte-for-byte identical apart from the one field the intent names.
		expect({ ...after, resolve: before.resolve }).toEqual(before);
		expect(readCharacterRow().version).toBe(5);

		const claims = sqlite
			.prepare('SELECT resulting_version, mutation_kind FROM character_version_claims WHERE character_id = ? ORDER BY resulting_version')
			.all('character-a') as Array<{ resulting_version: number; mutation_kind: string }>;
		expect(claims.at(-1)).toEqual({ resulting_version: 5, mutation_kind: 'session-resolve' });
	});

	it('refuses to spend Resolve the character does not have, and writes nothing', async () => {
		const zeroed = { ...readCharacterData(), resolve: { current: 0, max: 4 } };
		const saved = await saveWholeCharacter(db, {
			characterId: 'character-a',
			ownerUserId: PLAYER_A,
			actorUserId: PLAYER_A,
			expectedVersion: 4,
			data: zeroed
		});
		if (!saved.ok) throw new Error('fixture: zeroing save failed');

		const result = await applyResolveIntent(
			ctx,
			baseIntent({ expectedCharacterVersion: 5, expectedResolveCurrent: 0 })
		);

		expect(result).toEqual({ ok: false, reason: 'insufficient-resolve', currentResolve: 0, currentVersion: 5 });
		expect(readCharacterRow().version).toBe(5);
		expect(readCharacterData().resolve).toEqual({ current: 0, max: 4 });
	});

	it('rereads and reapplies over an unrelated sheet edit, preserving that edit', async () => {
		// The concurrent notes edit: version 4 -> 5, Resolve untouched at 3.
		const edited = { ...readCharacterData(), notes: 'the innkeeper is lying' };
		const saved = await saveWholeCharacter(db, {
			characterId: 'character-a',
			ownerUserId: PLAYER_A,
			actorUserId: PLAYER_A,
			expectedVersion: 4,
			data: edited
		});
		if (!saved.ok) throw new Error('fixture: notes save failed');

		// The intent still carries the version the player observed BEFORE that
		// edit. Version drift alone must not block the spend.
		const result = await applyResolveIntent(ctx, baseIntent());

		expect(result).toMatchObject({ ok: true, version: 6, resolveCurrent: 2 });
		const after = readCharacterData();
		expect(after.resolve).toEqual({ current: 2, max: 4 });
		expect(after.notes).toBe('the innkeeper is lying');
	});

	it('refuses when Resolve itself changed, reporting the current numbers and writing nothing', async () => {
		const spentElsewhere = { ...readCharacterData(), resolve: { current: 2, max: 4 } };
		const saved = await saveWholeCharacter(db, {
			characterId: 'character-a',
			ownerUserId: PLAYER_A,
			actorUserId: PLAYER_A,
			expectedVersion: 4,
			data: spentElsewhere
		});
		if (!saved.ok) throw new Error('fixture: competing spend failed');

		const result = await applyResolveIntent(ctx, baseIntent());

		expect(result).toEqual({ ok: false, reason: 'resource-changed', currentResolve: 2, currentVersion: 5 });
		expect(readCharacterRow().version).toBe(5);
		expect(readCharacterData().resolve).toEqual({ current: 2, max: 4 });
		const claimKinds = sqlite
			.prepare('SELECT mutation_kind FROM character_version_claims WHERE character_id = ?')
			.all('character-a') as Array<{ mutation_kind: string }>;
		expect(claimKinds.map((row) => row.mutation_kind)).not.toContain('session-resolve');
	});

	it('refuses a spend against a character the actor does not own', async () => {
		const result = await applyResolveIntent(ctx, baseIntent({ actorUserId: PLAYER_B }));

		expect(result).toEqual({ ok: false, reason: 'not-authorized' });
		expect(readCharacterRow().version).toBe(4);
	});

	it('refuses a spend once the tenure has ended', async () => {
		sqlite
			.prepare('UPDATE campaign_adventurer_tenures SET ended_at = ?, end_reason = ? WHERE id = ?')
			.run(200_000, 'left', 'tenure-a');

		const result = await applyResolveIntent(ctx, baseIntent());

		expect(result).toEqual({ ok: false, reason: 'not-found' });
		expect(readCharacterRow().version).toBe(4);
	});

	it('refuses a spend for a dead character', async () => {
		sqlite.prepare("UPDATE characters SET life_status = 'dead' WHERE id = ?").run('character-a');

		const result = await applyResolveIntent(ctx, baseIntent());

		expect(result).toEqual({ ok: false, reason: 'not-found' });
		expect(readCharacterRow().version).toBe(4);
	});

	it('never lets a session command carry a character document', () => {
		const smuggled = {
			commandId: 'cmd-1',
			observedSessionVersion: 1,
			observedCharacterVersion: 4,
			expectedResolveCurrent: 3,
			characterData: createBlankCharacter(),
			command: { type: 'draw', deck: 'player', destinationZoneId: 'hand:player-a', count: 1 }
		};

		expect(sessionCommandEnvelopeSchema.safeParse(smuggled).success).toBe(false);

		const legitimate = { ...smuggled, characterData: undefined };
		delete (legitimate as { characterData?: unknown }).characterData;
		expect(sessionCommandEnvelopeSchema.safeParse(legitimate).success).toBe(true);
	});

	describe('through the command service', () => {
		beforeEach(async () => {
			const started = await startSession({
				dbContext: ctx,
				campaignId: 'campaign-a',
				actorUserId: GM_USER,
				sessionId: 'session-a',
				shuffleSeed: 'resolve-command-seed',
				now: new Date(200_000)
			});
			if (!started.ok) throw new Error('fixture: session failed to start');
		});

		function envelope(overrides: Record<string, unknown> = {}) {
			return {
				commandId: 'spend-1',
				observedSessionVersion: 1,
				expectedStructuralVersion: 1,
				observedCharacterVersion: 4,
				expectedResolveCurrent: 3,
				command: { type: 'advance-procedure', procedureId: 'test-of-fate' },
				...overrides
			};
		}

		async function execute(body: Record<string, unknown>) {
			return executeCommand({
				dbContext: ctx,
				campaignId: 'campaign-a',
				sessionId: 'session-a',
				actorUserId: PLAYER_A,
				envelope: body
			});
		}

		it('refuses to spend Resolve from a command that is not a procedure step', async () => {
			const result = await execute(
				envelope({
					expectedStructuralVersion: undefined,
					command: { type: 'draw', deck: 'player', destinationZoneId: 'hand:player-a', count: 1 }
				})
			);

			expect(result.outcome).toEqual({ ok: false, code: 'illegal-command', message: 'only a procedure step may spend Resolve' });
			expect(readCharacterRow().version).toBe(4);
			expect(sqlite.prepare("SELECT count(*) AS n FROM session_commands WHERE session_id = 'session-a'").get()).toEqual({ n: 0 });
		});

		it('refuses, and persists nothing, when Resolve moved before the command arrived', async () => {
			const saved = await saveWholeCharacter(db, {
				characterId: 'character-a',
				ownerUserId: PLAYER_A,
				actorUserId: PLAYER_A,
				expectedVersion: 4,
				data: { ...readCharacterData(), resolve: { current: 1, max: 4 } }
			});
			if (!saved.ok) throw new Error('fixture: competing spend failed');

			const result = await execute(envelope());

			expect(result.outcome).toMatchObject({ ok: false, code: 'content-mismatch' });
			expect(result.outcome).toMatchObject({ message: expect.stringContaining('Resolve is now 1') });
			// No command row at all — so the reconfirmed retry may reuse this
			// commandId instead of replaying a stored refusal.
			expect(sqlite.prepare("SELECT count(*) AS n FROM session_commands WHERE session_id = 'session-a'").get()).toEqual({ n: 0 });
			expect(sqlite.prepare("SELECT version FROM play_sessions WHERE id = 'session-a'").get()).toEqual({ version: 1 });
			expect(readCharacterData().resolve).toEqual({ current: 1, max: 4 });
		});

		it('rejects an envelope that carries a character document', async () => {
			const result = await execute({ ...envelope(), characterData: createBlankCharacter() });

			expect(result.outcome).toEqual({ ok: false, code: 'illegal-command', message: 'malformed command envelope' });
			expect(readCharacterRow().version).toBe(4);
		});
	});

	it('requires both reconfirmation fields together on the envelope', () => {
		const base = {
			commandId: 'cmd-2',
			observedSessionVersion: 1,
			command: { type: 'draw', deck: 'player', destinationZoneId: 'hand:player-a', count: 1 }
		};

		// Neither: an ordinary command, still fine.
		expect(sessionCommandEnvelopeSchema.safeParse(base).success).toBe(true);
		// One without the other is never a valid reconfirmation.
		expect(sessionCommandEnvelopeSchema.safeParse({ ...base, observedCharacterVersion: 4 }).success).toBe(false);
		expect(sessionCommandEnvelopeSchema.safeParse({ ...base, expectedResolveCurrent: 3 }).success).toBe(false);
		expect(
			sessionCommandEnvelopeSchema.safeParse({ ...base, observedCharacterVersion: 4, expectedResolveCurrent: 3 }).success
		).toBe(true);
	});
});

function applyMigrations(sqlite: Database.Database): void {
	const directory = join(process.cwd(), 'src/lib/server/db/migrations');
	for (const filename of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
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
			`INSERT INTO character_version_claims
			(character_id, resulting_version, mutation_kind, actor_user_id, created_at)
			VALUES (?, 1, 'create', ?, 100)`
		)
		.run(characterId, userId);
}
