import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as schema from '$lib/server/db/schema';
import { campaignEvents, characterVersionClaims } from '$lib/server/db/schema';
import type { AppDb } from '$lib/server/db';
import { createBlankCharacter } from '$lib/types/character';
import { attachAdventurer } from '$lib/server/campaign/tenure';
import {
	correctCharacterDeath,
	markCharacterDead
} from '$lib/server/character/life';

describe('campaign-scoped character death', () => {
	let sqlite: Database.Database;
	let db: AppDb;

	beforeEach(async () => {
		sqlite = new Database(':memory:');
		sqlite.pragma('foreign_keys = ON');
		applyMigrations(sqlite);
		for (const userId of ['gm-a', 'gm-b', 'player-a']) {
			sqlite.prepare('INSERT INTO users (id) VALUES (?)').run(userId);
		}
		seedCampaign(sqlite, 'campaign-a', 'gm-a');
		seedCampaign(sqlite, 'campaign-b', 'gm-b');
		seedMembership(sqlite, 'membership-a', 'campaign-a', 'player-a');
		seedCharacter(sqlite, 'character-a', 'player-a');
		db = drizzle(sqlite, { schema });
		await attachAdventurer(db, {
			campaignId: 'campaign-a',
			membershipId: 'membership-a',
			actorUserId: 'player-a',
			characterId: 'character-a',
			tenureId: 'tenure-a',
			now: new Date(150_000)
		});
	});

	afterEach(() => sqlite.close());

	it('lets the character owner mark death and atomically releases the active tenure', async () => {
		await expect(
			markCharacterDead(db, {
				characterId: 'character-a',
				actorUserId: 'player-a',
				expectedVersion: 1,
				campaignId: 'campaign-a',
				now: new Date('2026-07-17T20:00:00.000Z')
			})
		).resolves.toEqual({ ok: true, version: 2, endedTenureId: 'tenure-a' });

		const stored = sqlite
			.prepare('SELECT data, version, life_status FROM characters WHERE id = ?')
			.get('character-a') as { data: string; version: number; life_status: string };
		expect(stored.version).toBe(2);
		expect(stored.life_status).toBe('dead');
		expect(JSON.parse(stored.data).life).toEqual({
			status: 'dead',
			diedAt: '2026-07-17T20:00:00.000Z',
			campaignId: 'campaign-a',
			markedByUserId: 'player-a'
		});
		expect(
			sqlite
				.prepare('SELECT end_reason, death_session_id FROM campaign_adventurer_tenures WHERE id = ?')
				.get('tenure-a')
		).toEqual({ end_reason: 'died', death_session_id: null });
		expect(
			sqlite
				.prepare(
					'SELECT mutation_kind, resulting_version FROM character_version_claims WHERE character_id = ? ORDER BY resulting_version'
				)
				.all('character-a')
		).toEqual([
			{ mutation_kind: 'create', resulting_version: 1 },
			{ mutation_kind: 'death', resulting_version: 2 }
		]);
	});

	it('allows only the scoped campaign GM to mark another player character dead', async () => {
		await expect(
			markCharacterDead(db, {
				characterId: 'character-a',
				actorUserId: 'gm-b',
				expectedVersion: 99,
				campaignId: 'campaign-a'
			})
		).resolves.toEqual({ ok: false, reason: 'not-found' });
		await expect(
			markCharacterDead(db, {
				characterId: 'character-a',
				actorUserId: 'gm-a',
				expectedVersion: 1,
				campaignId: 'campaign-a'
			})
		).resolves.toMatchObject({ ok: true, version: 2, endedTenureId: 'tenure-a' });
	});

	it('rolls back scoped GM death if active-tenure authorization is revoked before the claim', async () => {
		const originalInsert = db.insert.bind(db);
		let intercepted = false;
		(db as unknown as {
			insert: (table: typeof characterVersionClaims) => ReturnType<typeof originalInsert>;
		}).insert = (table) => {
			if (!intercepted && table === characterVersionClaims) {
				intercepted = true;
				sqlite
					.prepare("UPDATE campaign_adventurer_tenures SET ended_at = 250, end_reason = 'left' WHERE id = ?")
					.run('tenure-a');
			}
			return originalInsert(table);
		};

		await expect(
			markCharacterDead(db, {
				characterId: 'character-a',
				actorUserId: 'gm-a',
				expectedVersion: 1,
				campaignId: 'campaign-a'
			})
		).resolves.toEqual({ ok: false, reason: 'not-found' });
		expect(
			sqlite.prepare('SELECT version, life_status FROM characters WHERE id = ?').get('character-a')
		).toEqual({ version: 1, life_status: 'alive' });
	});

	it('refuses active-session death without cleanup and commits supplied cleanup atomically', async () => {
		const sessionState = {
			activeSessionId: async () => 'session-a',
			claimGuard: () => sql`1 = 1`
		};
		await expect(
			markCharacterDead(
				db,
				{
					characterId: 'character-a',
					actorUserId: 'player-a',
					expectedVersion: 1,
					campaignId: 'campaign-a'
				},
				{ sessionState }
			)
		).resolves.toEqual({ ok: false, reason: 'session-cleanup-unavailable' });
		expect(
			sqlite.prepare('SELECT version, life_status FROM characters WHERE id = ?').get('character-a')
		).toEqual({ version: 1, life_status: 'alive' });

		await expect(
			markCharacterDead(
				db,
				{
					characterId: 'character-a',
					actorUserId: 'player-a',
					expectedVersion: 1,
					campaignId: 'campaign-a',
					now: new Date('2026-07-17T21:00:00.000Z')
				},
				{
					sessionState,
					sessionCleanup: {
						statements: async (cleanupDb, input) => [
							cleanupDb.insert(campaignEvents).values({
								campaignId: input.campaignId,
								membershipId: input.membershipId,
								tenureId: input.tenureId,
								characterId: input.characterId,
								actorUserId: input.actorUserId,
								kind: 'session.death-cleanup',
								publicPayloadJson: '{}',
								createdAt: new Date('2026-07-17T21:00:00.000Z')
							})
						]
					}
				}
			)
		).resolves.toEqual({
			ok: true,
			version: 2,
			endedTenureId: 'tenure-a',
			sessionId: 'session-a'
		});
		expect(
			sqlite
				.prepare('SELECT kind FROM campaign_events WHERE campaign_id = ? ORDER BY id')
				.all('campaign-a')
				.map((row) => (row as { kind: string }).kind)
		).toContain('session.death-cleanup');
	});

	it('rethrows an unexpected death-cleanup statement failure without changing life state', async () => {
		const stableSession = {
			activeSessionId: async () => 'session-a',
			claimGuard: () => sql`1 = 1`
		};
		await expect(
			markCharacterDead(
				db,
				{
					characterId: 'character-a',
					actorUserId: 'player-a',
					expectedVersion: 1,
					campaignId: 'campaign-a'
				},
				{
					sessionState: stableSession,
					sessionCleanup: {
						statements: async (cleanupDb) => [
							cleanupDb.insert(campaignEvents).values({
								campaignId: 'missing-campaign',
								kind: 'session.cleanup',
								publicPayloadJson: '{}',
								createdAt: new Date(300_000)
							})
						]
					}
				}
			)
		).rejects.toThrow();
		expect(
			sqlite.prepare('SELECT version, life_status FROM characters WHERE id = ?').get('character-a')
		).toEqual({ version: 1, life_status: 'alive' });
	});

	it('corrects an erroneous death without restoring its ended tenure', async () => {
		await markCharacterDead(db, {
			characterId: 'character-a',
			actorUserId: 'gm-a',
			expectedVersion: 1,
			campaignId: 'campaign-a',
			now: new Date('2026-07-17T20:00:00.000Z')
		});
		await expect(
			correctCharacterDeath(db, {
				characterId: 'character-a',
				actorUserId: 'player-a',
				expectedVersion: 2,
				now: new Date('2026-07-17T22:00:00.000Z')
			})
		).resolves.toEqual({ ok: true, version: 3 });

		const stored = sqlite
			.prepare('SELECT data, version, life_status FROM characters WHERE id = ?')
			.get('character-a') as { data: string; version: number; life_status: string };
		expect(stored).toMatchObject({ version: 3, life_status: 'alive' });
		expect(JSON.parse(stored.data).life).toEqual({ status: 'alive' });
		expect(
			sqlite
				.prepare('SELECT count(*) AS count FROM campaign_adventurer_tenures WHERE ended_at IS NULL')
				.get()
		).toEqual({ count: 0 });
	});
});

function seedCampaign(sqlite: Database.Database, campaignId: string, ownerUserId: string): void {
	sqlite
		.prepare(
			`INSERT INTO campaigns
			(id, owner_user_id, name, description, created_at, updated_at)
			VALUES (?, ?, ?, '', 100, 100)`
		)
		.run(campaignId, ownerUserId, campaignId);
}

function seedMembership(
	sqlite: Database.Database,
	membershipId: string,
	campaignId: string,
	userId: string
): void {
	sqlite
		.prepare(
			'INSERT INTO campaign_members (id, campaign_id, user_id, joined_at) VALUES (?, ?, ?, 100)'
		)
		.run(membershipId, campaignId, userId);
}

function seedCharacter(sqlite: Database.Database, characterId: string, userId: string): void {
	const character = createBlankCharacter();
	character.name = characterId;
	character.isDraft = false;
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

function applyMigrations(sqlite: Database.Database): void {
	const directory = join(process.cwd(), 'src/lib/server/db/migrations');
	for (const filename of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
		sqlite.exec(readFileSync(join(directory, filename), 'utf8'));
	}
}
