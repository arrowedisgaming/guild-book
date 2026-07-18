import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as schema from '$lib/server/db/schema';
import { campaignEvents, campaignMembers } from '$lib/server/db/schema';
import type { AppDb } from '$lib/server/db';
import { createBlankCharacter } from '$lib/types/character';
import {
	closeCampaignInvite,
	createCampaign,
	rotateCampaignInvite
} from '$lib/server/campaign/service';
import {
	archiveCampaign,
	joinCampaignWithInvite,
	leaveCampaign,
	previewCampaignInvite,
	removeCampaignMember
} from '$lib/server/campaign/membership';

const SECRET = 'dedicated-membership-test-secret';

describe('campaign invitation membership lifecycle', () => {
	let sqlite: Database.Database;
	let db: AppDb;
	let inviteToken: string;

	beforeEach(async () => {
		sqlite = new Database(':memory:');
		sqlite.pragma('foreign_keys = ON');
		applyMigrations(sqlite);
		for (const userId of ['owner-a', 'player-a', 'player-b']) {
			sqlite.prepare('INSERT INTO users (id) VALUES (?)').run(userId);
		}
		db = drizzle(sqlite, { schema });
		const created = await createCampaign(db, {
			campaignId: 'campaign-a',
			ownerUserId: 'owner-a',
			name: 'The Lantern Guild',
			description: '',
			inviteSecret: SECRET,
			nonce: '0123456789abcdef0123456789abcdef',
			now: new Date(100_000)
		});
		inviteToken = created.inviteToken;
	});

	afterEach(() => sqlite.close());

	it('joins without an adventurer and returns the active membership idempotently', async () => {
		await expect(
			joinCampaignWithInvite(db, {
				token: inviteToken,
				secret: SECRET,
				userId: 'player-a',
				membershipId: 'membership-a',
				joinWithoutCharacter: true,
				now: new Date(200_000)
			})
		).resolves.toEqual({
			ok: true,
			campaignId: 'campaign-a',
			membershipId: 'membership-a',
			created: true,
			observer: true
		});

		await expect(
			joinCampaignWithInvite(db, {
				token: inviteToken,
				secret: SECRET,
				userId: 'player-a',
				membershipId: 'ignored-id',
				joinWithoutCharacter: true
			})
		).resolves.toEqual({
			ok: true,
			campaignId: 'campaign-a',
			membershipId: 'membership-a',
			created: false,
			observer: true
		});
	});

	it('previews an open invitation without joining and hides owner or closed-link details', async () => {
		await expect(
			previewCampaignInvite(db, {
				token: inviteToken,
				secret: SECRET,
				userId: 'player-a'
			})
		).resolves.toEqual({ campaignId: 'campaign-a', name: 'The Lantern Guild' });
		expect(
			sqlite.prepare('SELECT count(*) AS count FROM campaign_members').get()
		).toEqual({ count: 0 });
		await expect(
			previewCampaignInvite(db, {
				token: inviteToken,
				secret: SECRET,
				userId: 'owner-a'
			})
		).resolves.toBeNull();
		await closeCampaignInvite(db, { campaignId: 'campaign-a', ownerUserId: 'owner-a' });
		await expect(
			previewCampaignInvite(db, {
				token: inviteToken,
				secret: SECRET,
				userId: 'player-a'
			})
		).resolves.toBeNull();
	});

	it('atomically joins and attaches an eligible adventurer', async () => {
		seedCharacter(sqlite, 'character-a', 'player-a');
		await expect(
			joinCampaignWithInvite(db, {
				token: inviteToken,
				secret: SECRET,
				userId: 'player-a',
				membershipId: 'membership-a',
				characterId: 'character-a',
				tenureId: 'tenure-a',
				now: new Date(200_000)
			})
		).resolves.toEqual({
			ok: true,
			campaignId: 'campaign-a',
			membershipId: 'membership-a',
			tenureId: 'tenure-a',
			created: true,
			observer: false
		});
	});

	it('rolls back a combined join when adventurer eligibility fails', async () => {
		seedCharacter(sqlite, 'character-draft', 'player-a', true);
		await expect(
			joinCampaignWithInvite(db, {
				token: inviteToken,
				secret: SECRET,
				userId: 'player-a',
				membershipId: 'membership-a',
				characterId: 'character-draft'
			})
		).resolves.toEqual({ ok: false, reason: 'draft' });
		expect(
			sqlite.prepare('SELECT count(*) AS count FROM campaign_members WHERE user_id = ?').get('player-a')
		).toEqual({ count: 0 });
	});

	it('joins a new member as an observer when a session is active', async () => {
		seedCharacter(sqlite, 'character-a', 'player-a');
		await expect(
			joinCampaignWithInvite(
				db,
				{
					token: inviteToken,
					secret: SECRET,
					userId: 'player-a',
					membershipId: 'membership-a',
					characterId: 'character-a'
				},
				{ activeSessionId: async () => 'session-a', claimGuard: () => sql`1 = 1` }
			)
		).resolves.toEqual({
			ok: true,
			campaignId: 'campaign-a',
			membershipId: 'membership-a',
			created: true,
			observer: true
		});
		expect(
			sqlite.prepare('SELECT count(*) AS count FROM campaign_adventurer_tenures').get()
		).toEqual({ count: 0 });
	});

	it('rolls back joining if the invitation closes after validation', async () => {
		const originalInsert = db.insert.bind(db);
		let intercepted = false;
		(db as unknown as {
			insert: (table: typeof campaignMembers) => ReturnType<typeof originalInsert>;
		}).insert = (table) => {
			if (!intercepted && table === campaignMembers) {
				intercepted = true;
				sqlite.prepare('UPDATE campaigns SET join_open = 0 WHERE id = ?').run('campaign-a');
			}
			return originalInsert(table);
		};

		await expect(
			joinCampaignWithInvite(db, {
				token: inviteToken,
				secret: SECRET,
				userId: 'player-a',
				membershipId: 'membership-raced',
				joinWithoutCharacter: true
			})
		).resolves.toEqual({ ok: false, reason: 'invalid-invite' });
		expect(
			sqlite.prepare('SELECT count(*) AS count FROM campaign_members WHERE user_id = ?').get('player-a')
		).toEqual({ count: 0 });
	});

	it('rethrows an unexpected join write failure when the invitation state is unchanged', async () => {
		sqlite.exec(`
			CREATE TRIGGER fail_membership_join_event
			BEFORE INSERT ON campaign_events
			WHEN NEW.kind = 'membership.joined'
			BEGIN
				SELECT RAISE(ABORT, 'forced membership join event failure');
			END
		`);
		await expect(
			joinCampaignWithInvite(db, {
				token: inviteToken,
				secret: SECRET,
				userId: 'player-a',
				membershipId: 'membership-a',
				joinWithoutCharacter: true
			})
		).rejects.toThrow('forced membership join event failure');
		expect(
			sqlite.prepare('SELECT count(*) AS count FROM campaign_members WHERE user_id = ?').get('player-a')
		).toEqual({ count: 0 });
	});

	it('hides owner, closed, and rotated invite denials behind one invalid result', async () => {
		await expect(
			joinCampaignWithInvite(db, {
				token: inviteToken,
				secret: SECRET,
				userId: 'owner-a',
				joinWithoutCharacter: true
			})
		).resolves.toEqual({ ok: false, reason: 'invalid-invite' });

		await closeCampaignInvite(db, { campaignId: 'campaign-a', ownerUserId: 'owner-a' });
		await expect(
			joinCampaignWithInvite(db, {
				token: inviteToken,
				secret: SECRET,
				userId: 'player-a',
				joinWithoutCharacter: true
			})
		).resolves.toEqual({ ok: false, reason: 'invalid-invite' });

		await rotateCampaignInvite(db, {
			campaignId: 'campaign-a',
			ownerUserId: 'owner-a',
			secret: SECRET,
			nonce: 'fedcba9876543210fedcba9876543210'
		});
		await expect(
			joinCampaignWithInvite(db, {
				token: inviteToken,
				secret: SECRET,
				userId: 'player-b',
				joinWithoutCharacter: true
			})
		).resolves.toEqual({ ok: false, reason: 'invalid-invite' });
	});

	it('requires active-session cleanup before leaving, then revokes access and releases tenure', async () => {
		seedCharacter(sqlite, 'character-a', 'player-a');
		await joinCampaignWithInvite(db, {
			token: inviteToken,
			secret: SECRET,
			userId: 'player-a',
			membershipId: 'membership-a',
			characterId: 'character-a',
			tenureId: 'tenure-a'
		});
		const sessionState = {
			activeSessionId: async () => 'session-a',
			claimGuard: () => sql`1 = 1`
		};

		await expect(
			leaveCampaign(
				db,
				{
					campaignId: 'campaign-a',
					membershipId: 'membership-a',
					userId: 'player-a'
				},
				{ sessionState }
			)
		).resolves.toEqual({ ok: false, reason: 'session-cleanup-unavailable' });

		await expect(
			leaveCampaign(
				db,
				{
					campaignId: 'campaign-a',
					membershipId: 'membership-a',
					userId: 'player-a',
					now: new Date(300_000)
				},
				{
					sessionState,
					sessionCleanup: cleanupEventPort('session.membership-cleanup')
				}
			)
		).resolves.toEqual({
			ok: true,
			membershipId: 'membership-a',
			endedTenureId: 'tenure-a',
			sessionId: 'session-a'
		});
		expect(
			sqlite.prepare('SELECT left_at, removed_at FROM campaign_members WHERE id = ?').get('membership-a')
		).toEqual({ left_at: 300, removed_at: null });
		expect(
			sqlite.prepare('SELECT end_reason FROM campaign_adventurer_tenures WHERE id = ?').get('tenure-a')
		).toEqual({ end_reason: 'left' });
	});

	it('does not emit departure events or cleanup when its guarded claim loses', async () => {
		await joinCampaignWithInvite(db, {
			token: inviteToken,
			secret: SECRET,
			userId: 'player-a',
			membershipId: 'membership-a',
			joinWithoutCharacter: true
		});
		const beforeEvents = sqlite
			.prepare('SELECT count(*) AS count FROM campaign_events WHERE campaign_id = ?')
			.get('campaign-a');
		const originalUpdate = db.update.bind(db);
		let intercepted = false;
		(db as unknown as {
			update: (table: typeof campaignMembers) => ReturnType<typeof originalUpdate>;
		}).update = (table) => {
			if (!intercepted && table === campaignMembers) {
				intercepted = true;
				sqlite.prepare('UPDATE campaign_members SET left_at = 350 WHERE id = ?').run('membership-a');
			}
			return originalUpdate(table);
		};

		await expect(
			leaveCampaign(db, {
				campaignId: 'campaign-a',
				membershipId: 'membership-a',
				userId: 'player-a'
			})
		).resolves.toEqual({ ok: false, reason: 'conflict' });
		expect(
			sqlite
				.prepare('SELECT count(*) AS count FROM campaign_events WHERE campaign_id = ?')
				.get('campaign-a')
		).toEqual(beforeEvents);
	});

	it('rethrows an unexpected cleanup statement failure without revoking membership', async () => {
		await joinCampaignWithInvite(db, {
			token: inviteToken,
			secret: SECRET,
			userId: 'player-a',
			membershipId: 'membership-a',
			joinWithoutCharacter: true
		});
		const stableSession = {
			activeSessionId: async () => 'session-a',
			claimGuard: () => sql`1 = 1`
		};
		await expect(
			leaveCampaign(
				db,
				{
					campaignId: 'campaign-a',
					membershipId: 'membership-a',
					userId: 'player-a'
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
			sqlite.prepare('SELECT left_at FROM campaign_members WHERE id = ?').get('membership-a')
		).toEqual({ left_at: null });
	});

	it('gives GM removal the same cleanup and tenure-release contract', async () => {
		seedCharacter(sqlite, 'character-a', 'player-a');
		await joinCampaignWithInvite(db, {
			token: inviteToken,
			secret: SECRET,
			userId: 'player-a',
			membershipId: 'membership-a',
			characterId: 'character-a',
			tenureId: 'tenure-a'
		});
		await expect(
			removeCampaignMember(
				db,
				{
					campaignId: 'campaign-a',
					membershipId: 'membership-a',
					ownerUserId: 'owner-a',
					now: new Date(400_000)
				},
				{
					sessionState: {
						activeSessionId: async () => 'session-a',
						claimGuard: () => sql`1 = 1`
					},
					sessionCleanup: cleanupEventPort('session.removal-cleanup')
				}
			)
		).resolves.toEqual({
			ok: true,
			membershipId: 'membership-a',
			endedTenureId: 'tenure-a',
			sessionId: 'session-a'
		});
		expect(
			sqlite
				.prepare('SELECT left_at, removed_at, removed_by_user_id FROM campaign_members WHERE id = ?')
				.get('membership-a')
		).toEqual({ left_at: 400, removed_at: 400, removed_by_user_id: 'owner-a' });
		expect(
			sqlite.prepare('SELECT end_reason FROM campaign_adventurer_tenures WHERE id = ?').get('tenure-a')
		).toEqual({ end_reason: 'removed' });
	});

	it('denies campaign archive during a session and archives atomically outside one', async () => {
		await expect(
			archiveCampaign(
				db,
				{ campaignId: 'campaign-a', ownerUserId: 'owner-a' },
				{ activeSessionId: async () => 'session-a', claimGuard: () => sql`1 = 1` }
			)
		).resolves.toEqual({ ok: false, reason: 'session-active' });
		await expect(
			archiveCampaign(db, {
				campaignId: 'campaign-a',
				ownerUserId: 'owner-a',
				now: new Date(500_000)
			})
		).resolves.toEqual({ ok: true });
		expect(
			sqlite.prepare('SELECT archived_at, join_open FROM campaigns WHERE id = ?').get('campaign-a')
		).toEqual({ archived_at: 500, join_open: 0 });
	});

	it('rolls back archive if the observed no-session guard changes before its claim', async () => {
		let sessionReads = 0;
		await expect(
			archiveCampaign(
				db,
				{ campaignId: 'campaign-a', ownerUserId: 'owner-a' },
				{
					activeSessionId: async () => (sessionReads++ === 0 ? null : 'session-started'),
					claimGuard: () => sql`0 = 1`
				}
			)
		).resolves.toEqual({ ok: false, reason: 'conflict' });
		expect(
			sqlite.prepare('SELECT archived_at FROM campaigns WHERE id = ?').get('campaign-a')
		).toEqual({ archived_at: null });
	});

	it('rethrows an unexpected archive write failure when its guards remain stable', async () => {
		sqlite.exec(`
			CREATE TRIGGER fail_campaign_archive_event
			BEFORE INSERT ON campaign_events
			WHEN NEW.kind = 'campaign.archived'
			BEGIN
				SELECT RAISE(ABORT, 'forced campaign archive event failure');
			END
		`);
		await expect(
			archiveCampaign(db, { campaignId: 'campaign-a', ownerUserId: 'owner-a' })
		).rejects.toThrow('forced campaign archive event failure');
		expect(
			sqlite.prepare('SELECT archived_at, version FROM campaigns WHERE id = ?').get('campaign-a')
		).toEqual({ archived_at: null, version: 1 });
	});
});

function cleanupEventPort(kind: string) {
	return {
		statements: async (cleanupDb: AppDb, input: { campaignId: string; membershipId: string; actorUserId: string }) => [
			cleanupDb.insert(campaignEvents).values({
				campaignId: input.campaignId,
				membershipId: input.membershipId,
				actorUserId: input.actorUserId,
				kind,
				publicPayloadJson: '{}',
				createdAt: new Date(250_000)
			})
		]
	};
}

function seedCharacter(
	sqlite: Database.Database,
	characterId: string,
	userId: string,
	isDraft = false
): void {
	const character = createBlankCharacter();
	character.name = characterId;
	character.isDraft = isDraft;
	sqlite
		.prepare(
			`INSERT INTO characters
			(id, user_id, name, data, version, life_status, is_draft, is_archived, created_at, updated_at)
			VALUES (?, ?, ?, ?, 1, 'alive', ?, 0, 100, 100)`
		)
		.run(characterId, userId, character.name, JSON.stringify(character), isDraft ? 1 : 0);
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
