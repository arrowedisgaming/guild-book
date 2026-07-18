import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { Miniflare } from 'miniflare';
import * as schema from '$lib/server/db/schema';
import { campaigns } from '$lib/server/db/schema';
import type { AppDb } from '$lib/server/db';
import {
	closeCampaignInvite,
	createCampaign,
	createEmptyGuildRoster,
	getCampaignInvite,
	openCampaignInvite,
	rotateCampaignInvite,
	updateCampaignMetadata,
	updateGuildRoster
} from '$lib/server/campaign/service';

const SECRET = 'dedicated-d1-campaign-secret';

describe('campaign foundation service on D1', () => {
	let miniflare: Miniflare;
	let d1: D1Database;
	let db: AppDb;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: 'export default { fetch() { return new Response("ok") } }',
			d1Databases: ['DB']
		});
		d1 = await miniflare.getD1Database('DB');
		await applyMigrations(d1);
		db = drizzle(d1, { schema }) as unknown as AppDb;
		await d1
			.prepare('INSERT INTO users (id) VALUES (?), (?), (?)')
			.bind('d1-owner-atomic', 'd1-owner-stale', 'd1-owner-invites')
			.run();
	});

	afterAll(async () => {
		await miniflare.dispose();
	});

	it('rolls back the full D1 batch when the final campaign event insert fails', async () => {
		await d1.prepare(`
			CREATE TRIGGER reject_campaign_created_event
			BEFORE INSERT ON campaign_events
			WHEN NEW.campaign_id = 'd1-campaign-atomic'
			BEGIN
				SELECT RAISE(ABORT, 'forced event failure');
			END;
		`).run();

		await expect(
			createCampaign(db, {
				campaignId: 'd1-campaign-atomic',
				ownerUserId: 'd1-owner-atomic',
				name: 'D1 Atomic Guild',
				description: '',
				inviteSecret: SECRET,
				nonce: '11111111111111111111111111111111',
				now: new Date(100_000)
			})
		).rejects.toThrow(/forced event failure/i);

		const counts = await d1
			.prepare(`
				SELECT
					(SELECT count(*) FROM campaigns WHERE id = ?) AS campaigns,
					(SELECT count(*) FROM guild_rosters WHERE campaign_id = ?) AS rosters,
					(SELECT count(*) FROM campaign_events WHERE campaign_id = ?) AS events
			`)
			.bind('d1-campaign-atomic', 'd1-campaign-atomic', 'd1-campaign-atomic')
			.first<{ campaigns: number; rosters: number; events: number }>();
		expect(counts).toEqual({ campaigns: 0, rosters: 0, events: 0 });
	});

	it('uses D1 change metadata for stale campaign and roster guards', async () => {
		await createFixture('d1-campaign-stale', 'd1-owner-stale', '22222222222222222222222222222222');

		await expect(
			updateCampaignMetadata(db, {
				campaignId: 'd1-campaign-stale',
				ownerUserId: 'd1-owner-stale',
				expectedVersion: 1,
				name: 'Updated once'
			})
		).resolves.toEqual({ ok: true, version: 2 });
		await expect(
			updateCampaignMetadata(db, {
				campaignId: 'd1-campaign-stale',
				ownerUserId: 'd1-owner-stale',
				expectedVersion: 1,
				name: 'Stale update'
			})
		).resolves.toEqual({ ok: false, reason: 'version-conflict', currentVersion: 2 });

		const document = { ...createEmptyGuildRoster('D1 Guild'), terms: ['First write.'] };
		await expect(
			updateGuildRoster(db, {
				campaignId: 'd1-campaign-stale',
				ownerUserId: 'd1-owner-stale',
				expectedVersion: 1,
				document
			})
		).resolves.toEqual({ ok: true, version: 2 });
		await expect(
			updateGuildRoster(db, {
				campaignId: 'd1-campaign-stale',
				ownerUserId: 'd1-owner-stale',
				expectedVersion: 1,
				document: { ...document, terms: ['Stale write.'] }
			})
		).resolves.toEqual({ ok: false, reason: 'version-conflict', currentVersion: 2 });
	});

	it('serializes competing D1 invite rotations after close and reopen', async () => {
		const created = await createFixture(
			'd1-campaign-invites',
			'd1-owner-invites',
			'33333333333333333333333333333333'
		);
		await expect(
			closeCampaignInvite(db, {
				campaignId: 'd1-campaign-invites',
				ownerUserId: 'd1-owner-invites'
			})
		).resolves.toEqual({ ok: true });
		await expect(
			openCampaignInvite(db, {
				campaignId: 'd1-campaign-invites',
				ownerUserId: 'd1-owner-invites',
				secret: SECRET
			})
		).resolves.toEqual({ ok: true, token: created.inviteToken, version: 1 });

		const rotations = await Promise.all([
			rotateCampaignInvite(db, {
				campaignId: 'd1-campaign-invites',
				ownerUserId: 'd1-owner-invites',
				secret: SECRET,
				nonce: '44444444444444444444444444444444'
			}),
			rotateCampaignInvite(db, {
				campaignId: 'd1-campaign-invites',
				ownerUserId: 'd1-owner-invites',
				secret: SECRET,
				nonce: '55555555555555555555555555555555'
			})
		]);
		expect(rotations.every((result) => result.ok)).toBe(true);
		expect(
			rotations.map((result) => (result.ok ? result.version : 0)).sort((a, b) => a - b)
		).toEqual([2, 3]);

		const stored = await db
			.select({ inviteVersion: campaigns.inviteVersion, joinOpen: campaigns.joinOpen })
			.from(campaigns)
			.where(eq(campaigns.id, 'd1-campaign-invites'))
			.get();
		expect(stored).toEqual({ inviteVersion: 3, joinOpen: true });
		await expect(
			getCampaignInvite(db, {
				campaignId: 'd1-campaign-invites',
				ownerUserId: 'd1-owner-invites',
				secret: SECRET
			})
		).resolves.toMatchObject({ ok: true, version: 3 });
	});

	function createFixture(campaignId: string, ownerUserId: string, nonce: string) {
		return createCampaign(db, {
			campaignId,
			ownerUserId,
			name: 'D1 Guild',
			description: '',
			inviteSecret: SECRET,
			nonce,
			now: new Date(100_000)
		});
	}
});

async function applyMigrations(d1: D1Database): Promise<void> {
	const directory = join(process.cwd(), 'src/lib/server/db/migrations');
	for (const filename of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
		const statements = readFileSync(join(directory, filename), 'utf8')
			.split('--> statement-breakpoint')
			.map((statement) => statement.trim())
			.filter(Boolean);
		for (const statement of statements) await d1.prepare(statement).run();
	}
}
