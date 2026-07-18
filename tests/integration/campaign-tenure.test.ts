import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as schema from '$lib/server/db/schema';
import { campaignAdventurerTenures } from '$lib/server/db/schema';
import type { AppDb } from '$lib/server/db';
import {
	listEligibleAdventurersForUser,
	loadCampaignRosterView
} from '$lib/server/campaign/page-data';
import { createBlankCharacter } from '$lib/types/character';
import {
	attachAdventurer,
	evaluateAdventurerEligibility,
	replaceAdventurer
} from '$lib/server/campaign/tenure';

describe('campaign adventurer tenure eligibility', () => {
	it.each([
		[
			'not-owner',
			{ ownedByActor: false, finalized: true, lifeStatus: 'alive', archived: false, hasActiveTenure: false }
		],
		[
			'draft',
			{ ownedByActor: true, finalized: false, lifeStatus: 'alive', archived: false, hasActiveTenure: false }
		],
		[
			'dead',
			{ ownedByActor: true, finalized: true, lifeStatus: 'dead', archived: false, hasActiveTenure: false }
		],
		[
			'archived',
			{ ownedByActor: true, finalized: true, lifeStatus: 'alive', archived: true, hasActiveTenure: false }
		],
		[
			'already-attached',
			{ ownedByActor: true, finalized: true, lifeStatus: 'alive', archived: false, hasActiveTenure: true }
		]
	] as const)('rejects %s adventurers', (reason, facts) => {
		expect(evaluateAdventurerEligibility(facts)).toEqual({ ok: false, reason });
	});

	it('accepts an owned, finalized, living, unarchived, unattached adventurer', () => {
		expect(
			evaluateAdventurerEligibility({
				ownedByActor: true,
				finalized: true,
				lifeStatus: 'alive',
				archived: false,
				hasActiveTenure: false
			})
		).toEqual({ ok: true });
	});
});

describe('campaign adventurer tenure lifecycle', () => {
	let sqlite: Database.Database;
	let db: AppDb;

	beforeEach(() => {
		sqlite = new Database(':memory:');
		sqlite.pragma('foreign_keys = ON');
		applyMigrations(sqlite);
		for (const userId of ['owner-a', 'player-a']) {
			sqlite.prepare('INSERT INTO users (id) VALUES (?)').run(userId);
		}
		seedCampaign(sqlite, 'campaign-a', 'owner-a');
		seedMembership(sqlite, 'membership-a', 'campaign-a', 'player-a');
		db = drizzle(sqlite, { schema });
	});

	afterEach(() => sqlite.close());

	it('attaches an eligible adventurer when no session is active', async () => {
		seedCharacter(sqlite, 'character-a', 'player-a');

		await expect(
			attachAdventurer(db, {
				campaignId: 'campaign-a',
				membershipId: 'membership-a',
				actorUserId: 'player-a',
				characterId: 'character-a',
				tenureId: 'tenure-a',
				now: new Date(200_000)
			})
		).resolves.toEqual({ ok: true, tenureId: 'tenure-a' });

		expect(
			sqlite
				.prepare(
					'SELECT campaign_id, membership_id, character_id, ended_at FROM campaign_adventurer_tenures WHERE id = ?'
				)
				.get('tenure-a')
		).toEqual({
			campaign_id: 'campaign-a',
			membership_id: 'membership-a',
			character_id: 'character-a',
			ended_at: null
		});
	});

	it('rethrows an unexpected attachment write failure when its guards remain stable', async () => {
		seedCharacter(sqlite, 'character-a', 'player-a');
		sqlite.exec(`
			CREATE TRIGGER fail_adventurer_attach_event
			BEFORE INSERT ON campaign_events
			WHEN NEW.kind = 'adventurer.attached'
			BEGIN
				SELECT RAISE(ABORT, 'forced adventurer attachment event failure');
			END
		`);

		await expect(
			attachAdventurer(db, {
				campaignId: 'campaign-a',
				membershipId: 'membership-a',
				actorUserId: 'player-a',
				characterId: 'character-a',
				tenureId: 'tenure-a'
			})
		).rejects.toThrow('forced adventurer attachment event failure');
		expect(
			sqlite.prepare('SELECT count(*) AS count FROM campaign_adventurer_tenures').get()
		).toEqual({ count: 0 });
	});

	it('uses canonical migrated character JSON for final eligibility', async () => {
		seedCharacter(sqlite, 'character-dead', 'player-a', { life: { status: 'dead' } });
		await expect(
			attachAdventurer(db, {
				campaignId: 'campaign-a',
				membershipId: 'membership-a',
				actorUserId: 'player-a',
				characterId: 'character-dead'
			})
		).resolves.toEqual({ ok: false, reason: 'dead' });
	});

	it('blocks an initial active-session attachment but allows the current-session death exception', async () => {
		seedCharacter(sqlite, 'character-a', 'player-a');
		seedCharacter(sqlite, 'character-b', 'player-a');
		const activeSession = {
			activeSessionId: async () => 'session-a',
			claimGuard: () => sql`1 = 1`
		};

		await expect(
			attachAdventurer(
				db,
				{
					campaignId: 'campaign-a',
					membershipId: 'membership-a',
					actorUserId: 'player-a',
					characterId: 'character-a'
				},
				activeSession
			)
		).resolves.toEqual({ ok: false, reason: 'session-active' });

		sqlite
			.prepare(
				`INSERT INTO campaign_adventurer_tenures
				(id, campaign_id, membership_id, character_id, started_at, ended_at, end_reason, death_session_id)
				VALUES (?, ?, ?, ?, ?, ?, 'died', ?)`
			)
			.run('tenure-dead', 'campaign-a', 'membership-a', 'character-a', 100, 200, 'session-a');
		await expect(
			attachAdventurer(
				db,
				{
					campaignId: 'campaign-a',
					membershipId: 'membership-a',
					actorUserId: 'player-a',
					characterId: 'character-b',
					tenureId: 'tenure-replacement'
				},
				activeSession
			)
		).resolves.toEqual({ ok: true, tenureId: 'tenure-replacement' });
	});

	it('allows exactly one simultaneous attachment of a character across campaigns', async () => {
		seedCampaign(sqlite, 'campaign-b', 'owner-a');
		seedMembership(sqlite, 'membership-b', 'campaign-b', 'player-a');
		seedCharacter(sqlite, 'character-a', 'player-a');

		const results = await Promise.all([
			attachAdventurer(db, {
				campaignId: 'campaign-a',
				membershipId: 'membership-a',
				actorUserId: 'player-a',
				characterId: 'character-a',
				tenureId: 'tenure-a'
			}),
			attachAdventurer(db, {
				campaignId: 'campaign-b',
				membershipId: 'membership-b',
				actorUserId: 'player-a',
				characterId: 'character-a',
				tenureId: 'tenure-b'
			})
		]);
		expect(results.filter((result) => result.ok)).toHaveLength(1);
		expect(results.filter((result) => !result.ok)).toEqual([
			{ ok: false, reason: 'already-attached' }
		]);
	});

	it('rolls back attachment if membership is revoked after authorization', async () => {
		seedCharacter(sqlite, 'character-a', 'player-a');
		const originalInsert = db.insert.bind(db);
		let intercepted = false;
		(db as unknown as {
			insert: (table: typeof campaignAdventurerTenures) => ReturnType<typeof originalInsert>;
		}).insert = (table) => {
			if (!intercepted && table === campaignAdventurerTenures) {
				intercepted = true;
				sqlite.prepare('UPDATE campaign_members SET left_at = 250 WHERE id = ?').run('membership-a');
			}
			return originalInsert(table);
		};

		await expect(
			attachAdventurer(db, {
				campaignId: 'campaign-a',
				membershipId: 'membership-a',
				actorUserId: 'player-a',
				characterId: 'character-a',
				tenureId: 'tenure-raced'
			})
		).resolves.toEqual({ ok: false, reason: 'conflict' });
		expect(
			sqlite.prepare('SELECT count(*) AS count FROM campaign_adventurer_tenures').get()
		).toEqual({ count: 0 });
	});

	it('rolls back attachment if the validated character version changes before the claim', async () => {
		seedCharacter(sqlite, 'character-a', 'player-a');
		const originalInsert = db.insert.bind(db);
		let intercepted = false;
		(db as unknown as {
			insert: (table: typeof campaignAdventurerTenures) => ReturnType<typeof originalInsert>;
		}).insert = (table) => {
			if (!intercepted && table === campaignAdventurerTenures) {
				intercepted = true;
				const stored = sqlite.prepare('SELECT data FROM characters WHERE id = ?').get('character-a') as {
					data: string;
				};
				const data = JSON.parse(stored.data);
				data.life = {
					status: 'dead',
					diedAt: '2026-07-17T23:00:00.000Z',
					markedByUserId: 'player-a'
				};
				sqlite
					.prepare("UPDATE characters SET data = ?, version = 2, life_status = 'dead' WHERE id = ?")
					.run(JSON.stringify(data), 'character-a');
				sqlite
					.prepare(
						`INSERT INTO character_version_claims
						(character_id, resulting_version, mutation_kind, actor_user_id, created_at)
						VALUES (?, 2, 'death', ?, 250)`
					)
					.run('character-a', 'player-a');
			}
			return originalInsert(table);
		};

		await expect(
			attachAdventurer(db, {
				campaignId: 'campaign-a',
				membershipId: 'membership-a',
				actorUserId: 'player-a',
				characterId: 'character-a',
				tenureId: 'tenure-raced'
			})
		).resolves.toEqual({ ok: false, reason: 'dead' });
		expect(
			sqlite.prepare('SELECT count(*) AS count FROM campaign_adventurer_tenures').get()
		).toEqual({ count: 0 });
	});

	it('blocks voluntary replacement during a session and replaces atomically outside one', async () => {
		seedCharacter(sqlite, 'character-a', 'player-a');
		seedCharacter(sqlite, 'character-b', 'player-a');
		await attachAdventurer(db, {
			campaignId: 'campaign-a',
			membershipId: 'membership-a',
			actorUserId: 'player-a',
			characterId: 'character-a',
			tenureId: 'tenure-a',
			now: new Date(200_000)
		});

		await expect(
			replaceAdventurer(
				db,
				{
					campaignId: 'campaign-a',
					membershipId: 'membership-a',
					actorUserId: 'player-a',
					characterId: 'character-b'
				},
				{ activeSessionId: async () => 'session-a', claimGuard: () => sql`1 = 1` }
			)
		).resolves.toEqual({ ok: false, reason: 'session-active' });

		await expect(
			replaceAdventurer(db, {
				campaignId: 'campaign-a',
				membershipId: 'membership-a',
				actorUserId: 'player-a',
				characterId: 'character-b',
				tenureId: 'tenure-b',
				now: new Date(300_000)
			})
		).resolves.toEqual({ ok: true, tenureId: 'tenure-b', replacedTenureId: 'tenure-a' });

		expect(
			sqlite
				.prepare(
					'SELECT id, character_id, end_reason FROM campaign_adventurer_tenures WHERE membership_id = ? ORDER BY started_at'
				)
				.all('membership-a')
		).toEqual([
			{ id: 'tenure-a', character_id: 'character-a', end_reason: 'replaced' },
			{ id: 'tenure-b', character_id: 'character-b', end_reason: null }
		]);
	});

	it('rethrows an unexpected replacement write failure without ending the current tenure', async () => {
		seedCharacter(sqlite, 'character-a', 'player-a');
		seedCharacter(sqlite, 'character-b', 'player-a');
		await attachAdventurer(db, {
			campaignId: 'campaign-a',
			membershipId: 'membership-a',
			actorUserId: 'player-a',
			characterId: 'character-a',
			tenureId: 'tenure-a'
		});
		sqlite.exec(`
			CREATE TRIGGER fail_adventurer_replace_event
			BEFORE INSERT ON campaign_events
			WHEN NEW.kind = 'adventurer.replaced'
			BEGIN
				SELECT RAISE(ABORT, 'forced adventurer replacement event failure');
			END
		`);

		await expect(
			replaceAdventurer(db, {
				campaignId: 'campaign-a',
				membershipId: 'membership-a',
				actorUserId: 'player-a',
				characterId: 'character-b',
				tenureId: 'tenure-b'
			})
		).rejects.toThrow('forced adventurer replacement event failure');
		expect(
			sqlite
				.prepare('SELECT id, ended_at FROM campaign_adventurer_tenures ORDER BY started_at')
				.all()
		).toEqual([{ id: 'tenure-a', ended_at: null }]);
	});

	it('builds the page roster and filters ineligible adventurers on the server', async () => {
		seedCharacter(sqlite, 'attached-hero', 'player-a');
		seedCharacter(sqlite, 'eligible-hero', 'player-a');
		seedCharacter(sqlite, 'draft-hero', 'player-a', { draft: true });
		seedCharacter(sqlite, 'dead-hero', 'player-a', { life: { status: 'dead' } });
		seedCharacter(sqlite, 'archived-hero', 'player-a', { archived: true });
		await attachAdventurer(db, {
			campaignId: 'campaign-a',
			membershipId: 'membership-a',
			actorUserId: 'player-a',
			characterId: 'attached-hero',
			tenureId: 'tenure-a'
		});

		await expect(listEligibleAdventurersForUser(db, 'player-a')).resolves.toEqual([
			{ id: 'eligible-hero', name: 'eligible-hero' }
		]);
		await expect(loadCampaignRosterView(db, 'campaign-a')).resolves.toMatchObject({
			members: [{ id: 'membership-a', displayName: 'Guild member' }],
			tenures: [
				{
					id: 'tenure-a',
					membershipId: 'membership-a',
					characterName: 'attached-hero',
					endedAt: null
				}
			]
		});
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

function seedCharacter(
	sqlite: Database.Database,
	characterId: string,
	userId: string,
	overrides: { life?: { status: 'dead' }; draft?: boolean; archived?: boolean } = {}
): void {
	const character = createBlankCharacter();
	character.name = characterId;
	character.isDraft = overrides.draft ?? false;
	if (overrides.life?.status === 'dead') {
		character.life = {
			status: 'dead',
			diedAt: '2026-07-17T00:00:00.000Z',
			markedByUserId: userId
		};
	}
	sqlite
		.prepare(
			`INSERT INTO characters
			(id, user_id, name, data, version, life_status, is_draft, is_archived, created_at, updated_at)
			VALUES (?, ?, ?, ?, 1, 'alive', 0, ?, 100, 100)`
		)
		.run(characterId, userId, character.name, JSON.stringify(character), overrides.archived ? 1 : 0);
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
