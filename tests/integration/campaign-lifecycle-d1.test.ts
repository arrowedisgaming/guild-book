import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/d1';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { Miniflare } from 'miniflare';
import * as schema from '$lib/server/db/schema';
import {
	campaignAdventurerTenures,
	campaignEvents,
	campaignMembers,
	characters
} from '$lib/server/db/schema';
import type { AppDb } from '$lib/server/db';
import { createBlankCharacter } from '$lib/types/character';
import { createCharacterWithVersionClaim } from '$lib/server/character/versioned-write';
import { createCampaign } from '$lib/server/campaign/service';
import {
	archiveCampaign,
	joinCampaignWithInvite,
	leaveCampaign
} from '$lib/server/campaign/membership';
import { attachAdventurer } from '$lib/server/campaign/tenure';
import { markCharacterDead } from '$lib/server/character/life';

const SECRET = 'dedicated-d1-lifecycle-secret';

describe('campaign lifecycle on D1', () => {
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
		await d1.prepare('INSERT INTO users (id) VALUES (?), (?)').bind('d1-gm', 'd1-player').run();
	});

	afterAll(async () => miniflare.dispose());

	it('atomically joins, dies, replaces, and leaves through D1 batches', async () => {
		const campaign = await createCampaign(db, {
			campaignId: 'd1-lifecycle-campaign',
			ownerUserId: 'd1-gm',
			name: 'D1 Lifecycle Guild',
			description: '',
			inviteSecret: SECRET,
			nonce: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			now: new Date(100_000)
		});
		await createCharacter('d1-character-a', 100_000);
		await createCharacter('d1-character-b', 110_000);

		await expect(
			joinCampaignWithInvite(db, {
				token: campaign.inviteToken,
				secret: SECRET,
				userId: 'd1-player',
				membershipId: 'd1-membership',
				characterId: 'd1-character-a',
				tenureId: 'd1-tenure-a',
				now: new Date(200_000)
			})
		).resolves.toMatchObject({ ok: true, observer: false, tenureId: 'd1-tenure-a' });

		const sessionState = {
			activeSessionId: async () => 'd1-session',
			claimGuard: () => sql`1 = 1`
		};
		const sessionCleanup = {
			statements: async (cleanupDb: AppDb, input: { campaignId: string; membershipId: string; actorUserId: string }) => [
				cleanupDb.insert(campaignEvents).values({
					campaignId: input.campaignId,
					membershipId: input.membershipId,
					actorUserId: input.actorUserId,
					kind: 'session.cleanup',
					publicPayloadJson: '{}',
					createdAt: new Date(300_000)
				})
			]
		};
		await expect(
			markCharacterDead(
				db,
				{
					characterId: 'd1-character-a',
					actorUserId: 'd1-player',
					expectedVersion: 1,
					campaignId: 'd1-lifecycle-campaign',
					now: new Date(300_000)
				},
				{ sessionState, sessionCleanup }
			)
		).resolves.toMatchObject({
			ok: true,
			version: 2,
			endedTenureId: 'd1-tenure-a',
			sessionId: 'd1-session'
		});

		await expect(
			attachAdventurer(
				db,
				{
					campaignId: 'd1-lifecycle-campaign',
					membershipId: 'd1-membership',
					actorUserId: 'd1-player',
					characterId: 'd1-character-b',
					tenureId: 'd1-tenure-b',
					now: new Date(400_000)
				},
				sessionState
			)
		).resolves.toEqual({ ok: true, tenureId: 'd1-tenure-b' });

		await expect(
			leaveCampaign(
				db,
				{
					campaignId: 'd1-lifecycle-campaign',
					membershipId: 'd1-membership',
					userId: 'd1-player',
					now: new Date(500_000)
				},
				{ sessionState, sessionCleanup }
			)
		).resolves.toMatchObject({
			ok: true,
			endedTenureId: 'd1-tenure-b',
			sessionId: 'd1-session'
		});

		const membership = await db
			.select({ leftAt: campaignMembers.leftAt })
			.from(campaignMembers)
			.where(eq(campaignMembers.id, 'd1-membership'))
			.get();
		expect(membership?.leftAt).toEqual(new Date(500_000));
		const activeTenures = await db
			.select({ id: campaignAdventurerTenures.id })
			.from(campaignAdventurerTenures)
			.where(
				and(
					eq(campaignAdventurerTenures.membershipId, 'd1-membership'),
					isNull(campaignAdventurerTenures.endedAt)
				)
			);
		expect(activeTenures).toEqual([]);
		const dead = await db
			.select({ version: characters.version, lifeStatus: characters.lifeStatus })
			.from(characters)
			.where(eq(characters.id, 'd1-character-a'))
			.get();
		expect(dead).toEqual({ version: 2, lifeStatus: 'dead' });
	});

	it('rolls back a D1 batch when a conditional lifecycle claim inserts no row', async () => {
		await createCampaign(db, {
			campaignId: 'd1-guard-campaign',
			ownerUserId: 'd1-gm',
			name: 'D1 Guard Guild',
			description: '',
			inviteSecret: SECRET,
			nonce: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
			now: new Date(600_000)
		});
		let sessionReads = 0;
		await expect(
			archiveCampaign(
				db,
				{ campaignId: 'd1-guard-campaign', ownerUserId: 'd1-gm' },
				{
					activeSessionId: async () => (sessionReads++ === 0 ? null : 'session-started'),
					claimGuard: () => sql`0 = 1`
				}
			)
		).resolves.toEqual({ ok: false, reason: 'conflict' });

		const campaign = await d1
			.prepare('SELECT archived_at, version FROM campaigns WHERE id = ?')
			.bind('d1-guard-campaign')
			.first<{ archived_at: number | null; version: number }>();
		expect(campaign).toEqual({ archived_at: null, version: 1 });
		const archivedEvents = await d1
			.prepare("SELECT count(*) AS count FROM campaign_events WHERE campaign_id = ? AND kind = 'campaign.archived'")
			.bind('d1-guard-campaign')
			.first<{ count: number }>();
		expect(archivedEvents).toEqual({ count: 0 });
	});

	async function createCharacter(characterId: string, milliseconds: number): Promise<void> {
		const data = createBlankCharacter();
		data.name = characterId;
		data.isDraft = false;
		await createCharacterWithVersionClaim(db, {
			characterId,
			ownerUserId: 'd1-player',
			actorUserId: 'd1-player',
			data,
			createdAt: new Date(milliseconds)
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
