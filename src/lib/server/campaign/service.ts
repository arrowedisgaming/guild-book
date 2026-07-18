import { and, desc, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { nanoid } from 'nanoid';
import type { AppDb } from '$lib/server/db';
import * as schema from '$lib/server/db/schema';
import {
	campaignEvents,
	campaignMembers,
	campaigns,
	guildRosters
} from '$lib/server/db/schema';
import type {
	CampaignListItem,
	CampaignProjection,
	GuildRosterDocumentV1
} from '$lib/types/campaign';
import type { CampaignRole } from './access';
import { guildRosterDocumentV1Schema } from '$lib/schemas/campaign.schema';
import {
	createInviteNonce,
	inviteTokenStorage,
	issueInviteToken,
	sha256Hex
} from './invites';

type D1AppDb = DrizzleD1Database<typeof schema>;

export type VersionedCampaignResult =
	| { ok: true; version: number }
	| { ok: false; reason: 'not-found' }
	| { ok: false; reason: 'version-conflict'; currentVersion: number };

export function createEmptyGuildRoster(guildName: string): GuildRosterDocumentV1 {
	return {
		schemaVersion: 1,
		guildName,
		sigilDescription: '',
		terms: [],
		marchingOrder: [],
		roles: [],
		contracts: [],
		deeds: [],
		fame: 0
	};
}

export async function createCampaign(
	db: AppDb,
	input: {
		campaignId?: string;
		ownerUserId: string;
		name: string;
		description: string;
		inviteSecret: string;
		nonce?: string;
		now?: Date;
	}
) {
	const campaignId = input.campaignId ?? nanoid();
	const now = input.now ?? new Date();
	const nonce = input.nonce ?? createInviteNonce();
	const inviteToken = await issueInviteToken({
		campaignId,
		version: 1,
		nonce,
		secret: input.inviteSecret
	});
	const invite = await inviteTokenStorage(inviteToken, nonce, 1);
	const document = createEmptyGuildRoster(input.name);
	const campaignInsert = {
		id: campaignId,
		ownerUserId: input.ownerUserId,
		name: input.name,
		description: input.description,
		...invite,
		joinOpen: true,
		version: 1,
		createdAt: now,
		updatedAt: now
	};
	const rosterInsert = {
		campaignId,
		schemaVersion: document.schemaVersion,
		documentJson: JSON.stringify(document),
		version: 1,
		createdAt: now,
		updatedAt: now
	};
	const eventInsert = {
		campaignId,
		actorUserId: input.ownerUserId,
		kind: 'campaign.created',
		publicPayloadJson: JSON.stringify({ name: input.name }),
		createdAt: now
	};

	if (isD1Database(db)) {
		const d1 = db as unknown as D1AppDb;
		await d1.batch([
			d1.insert(campaigns).values(campaignInsert),
			d1.insert(guildRosters).values(rosterInsert),
			d1.insert(campaignEvents).values(eventInsert)
		]);
	} else {
		db.transaction((tx) => {
			tx.insert(campaigns).values(campaignInsert).run();
			tx.insert(guildRosters).values(rosterInsert).run();
			tx.insert(campaignEvents).values(eventInsert).run();
		});
	}

	return {
		campaign: {
			id: campaignId,
			name: input.name,
			description: input.description,
			version: 1,
			role: 'gm' as const,
			updatedAt: now
		},
		roster: { version: 1, document },
		inviteToken
	};
}

export async function listCampaignsForUser(db: AppDb, userId: string): Promise<CampaignListItem[]> {
	const rows = await db
		.select({
			id: campaigns.id,
			ownerUserId: campaigns.ownerUserId,
			name: campaigns.name,
			description: campaigns.description,
			version: campaigns.version,
			updatedAt: campaigns.updatedAt,
			membershipId: campaignMembers.id
		})
		.from(campaigns)
		.leftJoin(
			campaignMembers,
			and(
				eq(campaignMembers.campaignId, campaigns.id),
				eq(campaignMembers.userId, userId),
				isNull(campaignMembers.leftAt),
				isNull(campaignMembers.removedAt)
			)
		)
		.where(
			and(
				isNull(campaigns.archivedAt),
				or(eq(campaigns.ownerUserId, userId), isNotNull(campaignMembers.id))
			)
		)
		.orderBy(desc(campaigns.updatedAt));

	return rows.map((row) =>
		row.ownerUserId === userId
			? {
					id: row.id,
					name: row.name,
					description: row.description,
					version: row.version,
					role: 'gm',
					updatedAt: row.updatedAt
				}
			: {
					id: row.id,
					name: row.name,
					description: row.description,
					version: row.version,
					role: 'player',
					membershipId: row.membershipId!,
					updatedAt: row.updatedAt
				}
	);
}

export async function loadCampaignProjection(
	db: AppDb,
	role: CampaignRole
): Promise<CampaignProjection | null> {
	const row = await db
		.select({
			id: campaigns.id,
			name: campaigns.name,
			description: campaigns.description,
			version: campaigns.version,
			joinOpen: campaigns.joinOpen,
			inviteVersion: campaigns.inviteVersion,
			updatedAt: campaigns.updatedAt,
			rosterVersion: guildRosters.version,
			documentJson: guildRosters.documentJson
		})
		.from(campaigns)
		.innerJoin(guildRosters, eq(guildRosters.campaignId, campaigns.id))
		.where(and(eq(campaigns.id, role.campaignId), isNull(campaigns.archivedAt)))
		.get();
	if (!row) return null;

	return {
		id: row.id,
		name: row.name,
		description: row.description,
		version: row.version,
		role: role.kind,
		...(role.kind === 'player' ? { membershipId: role.membershipId } : {}),
		updatedAt: row.updatedAt,
		...(role.kind === 'gm'
			? { joinOpen: row.joinOpen, inviteVersion: row.inviteVersion }
			: {}),
		roster: {
			version: row.rosterVersion,
			document: guildRosterDocumentV1Schema.parse(JSON.parse(row.documentJson))
		}
	};
}

export async function updateCampaignMetadata(
	db: AppDb,
	input: {
		campaignId: string;
		ownerUserId: string;
		expectedVersion: number;
		name?: string;
		description?: string;
	}
): Promise<VersionedCampaignResult> {
	const result = await db
		.update(campaigns)
		.set({
			...(input.name === undefined ? {} : { name: input.name }),
			...(input.description === undefined ? {} : { description: input.description }),
			version: input.expectedVersion + 1,
			updatedAt: new Date()
		})
		.where(
			and(
				eq(campaigns.id, input.campaignId),
				eq(campaigns.ownerUserId, input.ownerUserId),
				eq(campaigns.version, input.expectedVersion),
				isNull(campaigns.archivedAt)
			)
		)
		.run();
	if (affectedRows(result) === 1) return { ok: true, version: input.expectedVersion + 1 };
	return classifyCampaignVersion(db, input.campaignId, input.ownerUserId);
}

export async function updateGuildRoster(
	db: AppDb,
	input: {
		campaignId: string;
		ownerUserId: string;
		expectedVersion: number;
		document: GuildRosterDocumentV1;
	}
): Promise<VersionedCampaignResult> {
	const result = await db
		.update(guildRosters)
		.set({
			schemaVersion: input.document.schemaVersion,
			documentJson: JSON.stringify(input.document),
			version: input.expectedVersion + 1,
			updatedAt: new Date()
		})
		.where(
			and(
				eq(guildRosters.campaignId, input.campaignId),
				eq(guildRosters.version, input.expectedVersion),
				sql`exists (
					select 1 from ${campaigns}
					where ${campaigns.id} = ${guildRosters.campaignId}
						and ${campaigns.ownerUserId} = ${input.ownerUserId}
						and ${campaigns.archivedAt} is null
				)`
			)
		)
		.run();
	if (affectedRows(result) === 1) return { ok: true, version: input.expectedVersion + 1 };

	const current = await db
		.select({ version: guildRosters.version })
		.from(guildRosters)
		.innerJoin(campaigns, eq(campaigns.id, guildRosters.campaignId))
		.where(
			and(
				eq(guildRosters.campaignId, input.campaignId),
				eq(campaigns.ownerUserId, input.ownerUserId),
				isNull(campaigns.archivedAt)
			)
		)
		.get();
	if (!current) return { ok: false, reason: 'not-found' };
	return { ok: false, reason: 'version-conflict', currentVersion: current.version };
}

export async function getCampaignInvite(
	db: AppDb,
	input: { campaignId: string; ownerUserId: string; secret: string }
): Promise<
	| { ok: true; token: string; version: number }
	| { ok: false; reason: 'not-found' | 'closed' }
> {
	const row = await readOwnerInvite(db, input.campaignId, input.ownerUserId);
	if (!row) return { ok: false, reason: 'not-found' };
	if (!row.joinOpen || !row.inviteNonce || !row.inviteTokenHash) {
		return { ok: false, reason: 'closed' };
	}

	const token = await issueInviteToken({
		campaignId: row.id,
		version: row.inviteVersion,
		nonce: row.inviteNonce,
		secret: input.secret
	});
	if ((await sha256Hex(token)) !== row.inviteTokenHash) {
		return { ok: false, reason: 'not-found' };
	}
	return { ok: true, token, version: row.inviteVersion };
}

export async function rotateCampaignInvite(
	db: AppDb,
	input: {
		campaignId: string;
		ownerUserId: string;
		secret: string;
		nonce?: string;
		now?: Date;
	}
): Promise<
	| { ok: true; token: string; version: number }
	| { ok: false; reason: 'not-found' | 'version-conflict' }
> {
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const row = await readOwnerInvite(db, input.campaignId, input.ownerUserId);
		if (!row) return { ok: false, reason: 'not-found' };

		const version = row.inviteVersion + 1;
		const nonce = input.nonce ?? createInviteNonce();
		const token = await issueInviteToken({
			campaignId: row.id,
			version,
			nonce,
			secret: input.secret
		});
		const storage = await inviteTokenStorage(token, nonce, version);
		const result = await db
			.update(campaigns)
			.set({ ...storage, joinOpen: true, updatedAt: input.now ?? new Date() })
			.where(
				and(
					eq(campaigns.id, input.campaignId),
					eq(campaigns.ownerUserId, input.ownerUserId),
					eq(campaigns.inviteVersion, row.inviteVersion),
					isNull(campaigns.archivedAt)
				)
			)
			.run();
		if (affectedRows(result) === 1) return { ok: true, token, version };
	}

	return { ok: false, reason: 'version-conflict' };
}

export async function closeCampaignInvite(
	db: AppDb,
	input: { campaignId: string; ownerUserId: string }
): Promise<{ ok: true } | { ok: false; reason: 'not-found' }> {
	const result = await db
		.update(campaigns)
		.set({ joinOpen: false, updatedAt: new Date() })
		.where(
			and(
				eq(campaigns.id, input.campaignId),
				eq(campaigns.ownerUserId, input.ownerUserId),
				isNull(campaigns.archivedAt)
			)
		)
		.run();
	return affectedRows(result) === 1 ? { ok: true } : { ok: false, reason: 'not-found' };
}

export async function openCampaignInvite(
	db: AppDb,
	input: { campaignId: string; ownerUserId: string; secret: string; now?: Date }
): Promise<
	| { ok: true; token: string; version: number }
	| { ok: false; reason: 'not-found' | 'version-conflict' }
> {
	const row = await readOwnerInvite(db, input.campaignId, input.ownerUserId);
	if (!row || !row.inviteNonce || !row.inviteTokenHash || !row.inviteTokenPrefix) {
		return { ok: false, reason: 'not-found' };
	}

	const token = await issueInviteToken({
		campaignId: row.id,
		version: row.inviteVersion,
		nonce: row.inviteNonce,
		secret: input.secret
	});
	const tokenHash = await sha256Hex(token);
	if (tokenHash !== row.inviteTokenHash || tokenHash.slice(0, 16) !== row.inviteTokenPrefix) {
		return { ok: false, reason: 'not-found' };
	}
	if (row.joinOpen) return { ok: true, token, version: row.inviteVersion };

	const result = await db
		.update(campaigns)
		.set({ joinOpen: true, updatedAt: input.now ?? new Date() })
		.where(
			and(
				eq(campaigns.id, input.campaignId),
				eq(campaigns.ownerUserId, input.ownerUserId),
				eq(campaigns.inviteVersion, row.inviteVersion),
				eq(campaigns.inviteNonce, row.inviteNonce),
				eq(campaigns.inviteTokenHash, row.inviteTokenHash),
				eq(campaigns.joinOpen, false),
				isNull(campaigns.archivedAt)
			)
		)
		.run();
	return affectedRows(result) === 1
		? { ok: true, token, version: row.inviteVersion }
		: { ok: false, reason: 'version-conflict' };
}

async function readOwnerInvite(db: AppDb, campaignId: string, ownerUserId: string) {
	return db
		.select({
			id: campaigns.id,
			inviteNonce: campaigns.inviteNonce,
			inviteVersion: campaigns.inviteVersion,
			inviteTokenHash: campaigns.inviteTokenHash,
			inviteTokenPrefix: campaigns.inviteTokenPrefix,
			joinOpen: campaigns.joinOpen
		})
		.from(campaigns)
		.where(
			and(
				eq(campaigns.id, campaignId),
				eq(campaigns.ownerUserId, ownerUserId),
				isNull(campaigns.archivedAt)
			)
		)
		.get();
}

async function classifyCampaignVersion(
	db: AppDb,
	campaignId: string,
	ownerUserId: string
): Promise<VersionedCampaignResult> {
	const current = await db
		.select({ version: campaigns.version })
		.from(campaigns)
		.where(
			and(
				eq(campaigns.id, campaignId),
				eq(campaigns.ownerUserId, ownerUserId),
				isNull(campaigns.archivedAt)
			)
		)
		.get();
	if (!current) return { ok: false, reason: 'not-found' };
	return { ok: false, reason: 'version-conflict', currentVersion: current.version };
}

function isD1Database(db: AppDb): boolean {
	return typeof (db as unknown as { batch?: unknown }).batch === 'function';
}

function affectedRows(result: unknown): number {
	if (!result || typeof result !== 'object') return 0;
	const direct = (result as { changes?: unknown }).changes;
	if (typeof direct === 'number') return direct;
	const meta = (result as { meta?: { changes?: unknown } }).meta;
	return typeof meta?.changes === 'number' ? meta.changes : 0;
}
