import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq, sql } from 'drizzle-orm';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as schema from '$lib/server/db/schema';
import { campaignEvents, campaigns, guildRosters } from '$lib/server/db/schema';
import type { AppDb } from '$lib/server/db';
import {
	closeCampaignInvite,
	createCampaign,
	createEmptyGuildRoster,
	getCampaignInvite,
	listCampaignsForUser,
	openCampaignInvite,
	rotateCampaignInvite,
	updateCampaignMetadata,
	updateGuildRoster
} from '$lib/server/campaign/service';
import {
	createCampaignSchema,
	updateCampaignSchema,
	updateGuildRosterSchema
} from '$lib/schemas/campaign.schema';

const SECRET = 'dedicated-test-campaign-secret';
const NONCE = '0123456789abcdef0123456789abcdef';

describe('campaign foundation service', () => {
	let sqlite: Database.Database;
	let db: AppDb;

	beforeEach(() => {
		sqlite = new Database(':memory:');
		sqlite.pragma('foreign_keys = ON');
		applyMigrations(sqlite);
		for (const userId of ['owner-a', 'player-a', 'former-a']) {
			sqlite.prepare('INSERT INTO users (id) VALUES (?)').run(userId);
		}
		db = drizzle(sqlite, { schema });
	});

	afterEach(() => sqlite.close());

	it('validates bounded campaign and roster commands', () => {
		expect(createCampaignSchema.safeParse({ name: '', description: '' }).success).toBe(false);
		expect(createCampaignSchema.safeParse({ name: 'A'.repeat(101), description: '' }).success).toBe(
			false
		);
		expect(
			updateCampaignSchema.safeParse({ expectedVersion: 1, name: 'Renamed Guild' }).success
		).toBe(true);
		expect(
			updateGuildRosterSchema.safeParse({
				expectedVersion: 1,
				document: { ...createEmptyGuildRoster('Guild'), fame: -1 }
			}).success
		).toBe(false);
		const roster = createEmptyGuildRoster('Guild');
		expect(
			updateGuildRosterSchema.safeParse({
				expectedVersion: 1,
				document: {
					...roster,
					deeds: [{ id: 'deed-a', text: 'Lit the beacon.', occurredAt: '2026-07-17T20:15:30Z' }]
				}
			}).success
		).toBe(true);
		for (const occurredAt of ['sometime yesterday', '2026-07-17T16:15:30-04:00']) {
			expect(
				updateGuildRosterSchema.safeParse({
					expectedVersion: 1,
					document: {
						...roster,
						deeds: [{ id: 'deed-a', text: 'Lit the beacon.', occurredAt }]
					}
				}).success
			).toBe(false);
		}
	});

	it('atomically creates campaign, roster, first event, and hashed invite metadata', async () => {
		const created = await createFixture(db);

		expect(created.campaign).toMatchObject({
			id: 'campaign-a',
			name: 'The Lantern Guild',
			role: 'gm',
			version: 1
		});
		expect(created.roster.document.guildName).toBe('The Lantern Guild');
		expect(created.inviteToken).not.toContain(SECRET);

		const stored = await db.select().from(campaigns).where(eq(campaigns.id, 'campaign-a')).get();
		expect(stored).toMatchObject({
			inviteNonce: NONCE,
			inviteVersion: 1,
			joinOpen: true
		});
		expect(stored!.inviteTokenPrefix).toHaveLength(16);
		expect(stored!.inviteTokenHash).toHaveLength(64);
		expect(JSON.stringify(stored)).not.toContain(created.inviteToken);
		expect(JSON.stringify(stored)).not.toContain(SECRET);

		const roster = await db
			.select()
			.from(guildRosters)
			.where(eq(guildRosters.campaignId, 'campaign-a'))
			.get();
		expect(JSON.parse(roster!.documentJson)).toEqual(createEmptyGuildRoster('The Lantern Guild'));
		const events = await db
			.select({ kind: campaignEvents.kind })
			.from(campaignEvents)
			.where(eq(campaignEvents.campaignId, 'campaign-a'));
		expect(events).toEqual([{ kind: 'campaign.created' }]);
	});

	it('rolls back the roster and event if campaign creation collides', async () => {
		await createFixture(db);
		await expect(createFixture(db)).rejects.toThrow();

		const [campaignCount] = await db
			.select({ count: sql<number>`count(*)` })
			.from(campaigns)
			.where(eq(campaigns.id, 'campaign-a'));
		const [rosterCount] = await db
			.select({ count: sql<number>`count(*)` })
			.from(guildRosters)
			.where(eq(guildRosters.campaignId, 'campaign-a'));
		const [eventCount] = await db
			.select({ count: sql<number>`count(*)` })
			.from(campaignEvents)
			.where(eq(campaignEvents.campaignId, 'campaign-a'));
		expect([campaignCount.count, rosterCount.count, eventCount.count]).toEqual([1, 1, 1]);
	});

	it('guards campaign metadata and roster documents with independent versions', async () => {
		await createFixture(db);
		const metadata = await updateCampaignMetadata(db, {
			campaignId: 'campaign-a',
			ownerUserId: 'owner-a',
			expectedVersion: 1,
			name: 'The Ember Guild',
			description: 'Renamed safely.'
		});
		expect(metadata).toEqual({ ok: true, version: 2 });
		await expect(
			updateCampaignMetadata(db, {
				campaignId: 'campaign-a',
				ownerUserId: 'owner-a',
				expectedVersion: 1,
				name: 'Stale Name'
			})
		).resolves.toEqual({ ok: false, reason: 'version-conflict', currentVersion: 2 });

		const document = { ...createEmptyGuildRoster('The Ember Guild'), terms: ['Keep the light.'] };
		const roster = await updateGuildRoster(db, {
			campaignId: 'campaign-a',
			ownerUserId: 'owner-a',
			expectedVersion: 1,
			document
		});
		expect(roster).toEqual({ ok: true, version: 2 });
		await expect(
			updateGuildRoster(db, {
				campaignId: 'campaign-a',
				ownerUserId: 'owner-a',
				expectedVersion: 1,
				document: { ...document, terms: ['stale'] }
			})
		).resolves.toEqual({ ok: false, reason: 'version-conflict', currentVersion: 2 });

		const stored = await db
			.select({ documentJson: guildRosters.documentJson })
			.from(guildRosters)
			.where(eq(guildRosters.campaignId, 'campaign-a'))
			.get();
		expect(JSON.parse(stored!.documentJson).terms).toEqual(['Keep the light.']);
	});

	it('rejects a roster write when the campaign is archived between authorization and update', async () => {
		await createFixture(db);
		const originalUpdate = db.update.bind(db);
		let intercepted = false;
		(db as unknown as { update: (table: typeof guildRosters) => ReturnType<typeof originalUpdate> }).update =
			(table) => {
				if (!intercepted && table === guildRosters) {
					intercepted = true;
					sqlite
						.prepare('UPDATE campaigns SET archived_at = ? WHERE id = ?')
						.run(150_000, 'campaign-a');
				}
				return originalUpdate(table);
			};

		const document = { ...createEmptyGuildRoster('The Lantern Guild'), terms: ['Too late.'] };
		await expect(
			updateGuildRoster(db, {
				campaignId: 'campaign-a',
				ownerUserId: 'owner-a',
				expectedVersion: 1,
				document
			})
		).resolves.toEqual({ ok: false, reason: 'not-found' });

		const stored = await db
			.select({ documentJson: guildRosters.documentJson })
			.from(guildRosters)
			.where(eq(guildRosters.campaignId, 'campaign-a'))
			.get();
		expect(JSON.parse(stored!.documentJson).terms).toEqual([]);
	});

	it('reproduces, closes, reopens, and rotates owner invite links without storing raw tokens', async () => {
		const created = await createFixture(db);
		await expect(
			getCampaignInvite(db, {
				campaignId: 'campaign-a',
				ownerUserId: 'owner-a',
				secret: SECRET
			})
		).resolves.toEqual({ ok: true, token: created.inviteToken, version: 1 });

		const rotated = await rotateCampaignInvite(db, {
			campaignId: 'campaign-a',
			ownerUserId: 'owner-a',
			secret: SECRET,
			nonce: 'fedcba9876543210fedcba9876543210',
			now: new Date(200_000)
		});
		expect(rotated).toMatchObject({ ok: true, version: 2 });
		if (!rotated.ok) throw new Error('Expected invite rotation to succeed');
		expect(rotated.token).not.toBe(created.inviteToken);
		await expect(
			getCampaignInvite(db, {
				campaignId: 'campaign-a',
				ownerUserId: 'owner-a',
				secret: SECRET
			})
		).resolves.toEqual({ ok: true, token: rotated.token, version: 2 });

		await expect(
			closeCampaignInvite(db, { campaignId: 'campaign-a', ownerUserId: 'owner-a' })
		).resolves.toEqual({ ok: true });
		await expect(
			getCampaignInvite(db, {
				campaignId: 'campaign-a',
				ownerUserId: 'owner-a',
				secret: SECRET
			})
		).resolves.toEqual({ ok: false, reason: 'closed' });

		const beforeReopen = await db.select().from(campaigns).where(eq(campaigns.id, 'campaign-a')).get();
		await expect(
			openCampaignInvite(db, {
				campaignId: 'campaign-a',
				ownerUserId: 'owner-a',
				secret: SECRET
			})
		).resolves.toEqual({ ok: true, token: rotated.token, version: 2 });
		const afterReopen = await db.select().from(campaigns).where(eq(campaigns.id, 'campaign-a')).get();
		expect(afterReopen).toMatchObject({
			joinOpen: true,
			inviteNonce: beforeReopen!.inviteNonce,
			inviteTokenHash: beforeReopen!.inviteTokenHash,
			inviteTokenPrefix: beforeReopen!.inviteTokenPrefix,
			inviteVersion: beforeReopen!.inviteVersion
		});
	});

	it('lists only owned or active-member campaigns with scoped roles', async () => {
		await createFixture(db);
		sqlite
			.prepare(
				'INSERT INTO campaign_members (id, campaign_id, user_id, joined_at, left_at) VALUES (?, ?, ?, ?, ?)'
			)
			.run('membership-player', 'campaign-a', 'player-a', 100, null);
		sqlite
			.prepare(
				'INSERT INTO campaign_members (id, campaign_id, user_id, joined_at, left_at) VALUES (?, ?, ?, ?, ?)'
			)
			.run('membership-former', 'campaign-a', 'former-a', 100, 200);

		await expect(listCampaignsForUser(db, 'owner-a')).resolves.toMatchObject([{ role: 'gm' }]);
		await expect(listCampaignsForUser(db, 'player-a')).resolves.toMatchObject([
			{ role: 'player', membershipId: 'membership-player' }
		]);
		await expect(listCampaignsForUser(db, 'former-a')).resolves.toEqual([]);
	});
});

function createFixture(db: AppDb) {
	return createCampaign(db, {
		campaignId: 'campaign-a',
		ownerUserId: 'owner-a',
		name: 'The Lantern Guild',
		description: 'We keep the dark at bay.',
		inviteSecret: SECRET,
		nonce: NONCE,
		now: new Date(100_000)
	});
}

function applyMigrations(sqlite: Database.Database): void {
	const directory = join(process.cwd(), 'src/lib/server/db/migrations');
	for (const filename of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
		sqlite.exec(readFileSync(join(directory, filename), 'utf8'));
	}
}
