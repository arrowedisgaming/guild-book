import { and, eq, exists, isNull, or, sql, type SQL } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { AppDb } from '$lib/server/db';
import {
	campaignAdventurerTenures,
	campaignEvents,
	campaignMembers,
	campaignMutationClaims,
	campaigns,
	characters,
	characterVersionClaims
} from '$lib/server/db/schema';
import { migrateCharacterData } from '$lib/engine/character-migration';
import {
	mutationClaimReceipt,
	runCampaignAtomic,
	type CampaignAtomicStatement
} from '$lib/server/campaign/atomic';
import {
	noSessionsYet,
	type SessionCleanupPort,
	type SessionStatePort
} from '$lib/server/campaign/session-state-port';

export type CharacterLifeMutationResult =
	| {
			ok: true;
			version: number;
			endedTenureId?: string;
			sessionId?: string;
	  }
	| {
			ok: false;
			reason:
				| 'not-found'
				| 'already-dead'
				| 'not-dead'
				| 'session-cleanup-unavailable'
				| 'conflict';
	  }
	| { ok: false; reason: 'version-conflict'; currentVersion: number };

interface LifeMutationPorts {
	sessionState?: SessionStatePort;
	sessionCleanup?: SessionCleanupPort;
}

export async function markCharacterDead(
	db: AppDb,
	input: {
		characterId: string;
		actorUserId: string;
		expectedVersion: number;
		campaignId?: string;
		now?: Date;
	},
	ports: LifeMutationPorts = {}
): Promise<CharacterLifeMutationResult> {
	const character = await readCharacter(db, input.characterId);
	if (!character) return { ok: false, reason: 'not-found' };
	const data = parseCharacterData(character.data);
	const tenure = await readActiveTenureContext(db, input.characterId);
	if (input.campaignId && tenure?.campaignId !== input.campaignId) {
		return { ok: false, reason: 'not-found' };
	}
	if (character.userId !== input.actorUserId && tenure?.campaignOwnerUserId !== input.actorUserId) {
		return { ok: false, reason: 'not-found' };
	}
	if (character.version !== input.expectedVersion) {
		return { ok: false, reason: 'version-conflict', currentVersion: character.version };
	}
	if (data.life.status === 'dead') return { ok: false, reason: 'already-dead' };

	const campaignId = tenure?.campaignId;
	const sessionState = ports.sessionState ?? noSessionsYet;
	const sessionId = campaignId ? await sessionState.activeSessionId(campaignId) : null;
	let cleanupStatements: CampaignAtomicStatement[] = [];
	if (sessionId && tenure) {
		if (!ports.sessionCleanup) {
			return { ok: false, reason: 'session-cleanup-unavailable' };
		}
		cleanupStatements = await ports.sessionCleanup.statements(db, {
			kind: 'death',
			campaignId: tenure.campaignId,
			sessionId,
			membershipId: tenure.membershipId,
			tenureId: tenure.id,
			characterId: input.characterId,
			actorUserId: input.actorUserId
		});
	}

	const now = input.now ?? new Date();
	const claimId = nanoid();
	const resultingVersion = input.expectedVersion + 1;
	data.life = {
		status: 'dead',
		diedAt: now.toISOString(),
		...(campaignId ? { campaignId } : {}),
		...(sessionId ? { sessionId } : {}),
		markedByUserId: input.actorUserId
	};
	const statements: CampaignAtomicStatement[] = [
		characterLifeClaim(db, {
			claimId,
			kind: 'character.death',
			characterId: input.characterId,
			actorUserId: input.actorUserId,
			expectedVersion: input.expectedVersion,
			expectedLifeStatus: 'alive',
			campaignId,
			tenure,
			now,
			sessionGuard: sessionState.claimGuard(campaignId ?? '', sessionId)
		}),
		db.insert(characterVersionClaims).values({
			characterId: input.characterId,
			resultingVersion,
			mutationKind: 'death',
			actorUserId: input.actorUserId,
			createdAt: now
		}),
		db
			.update(characters)
			.set({
				data: JSON.stringify(data),
				lifeStatus: 'dead',
				version: resultingVersion,
				updatedAt: now
			})
			.where(
				and(
					eq(characters.id, input.characterId),
					eq(characters.version, input.expectedVersion)
				)
			)
	];
	if (tenure) {
		statements.push(
			db
				.update(campaignAdventurerTenures)
				.set({
					endedAt: now,
					endedByUserId: input.actorUserId,
					endReason: 'died',
					deathSessionId: sessionId
				})
				.where(
					and(
						eq(campaignAdventurerTenures.id, tenure.id),
						isNull(campaignAdventurerTenures.endedAt)
					)
				)
		);
	}
	statements.push(mutationClaimReceipt(db, claimId));
	statements.push(...cleanupStatements);
	if (tenure) {
		statements.push(
			db.insert(campaignEvents).values({
				campaignId: tenure.campaignId,
				membershipId: tenure.membershipId,
				tenureId: tenure.id,
				characterId: input.characterId,
				actorUserId: input.actorUserId,
				kind: 'adventurer.died',
				publicPayloadJson: JSON.stringify({
					membershipId: tenure.membershipId,
					characterId: input.characterId,
					...(sessionId ? { sessionId } : {})
				}),
				createdAt: now
			})
		);
	}

	try {
		await runCampaignAtomic(db, statements);
	} catch (cause) {
		const failure = await classifyDeathWriteFailure(db, {
			characterId: input.characterId,
			actorUserId: input.actorUserId,
			expectedVersion: input.expectedVersion,
			campaignId,
			observedTenure: tenure,
			observedSessionId: sessionId,
			sessionState
		});
		if (failure) return failure;
		throw cause;
	}
	return {
		ok: true,
		version: resultingVersion,
		...(tenure ? { endedTenureId: tenure.id } : {}),
		...(sessionId ? { sessionId } : {})
	};
}

export async function correctCharacterDeath(
	db: AppDb,
	input: {
		characterId: string;
		actorUserId: string;
		expectedVersion: number;
		now?: Date;
	}
): Promise<CharacterLifeMutationResult> {
	const character = await readCharacter(db, input.characterId);
	if (!character) return { ok: false, reason: 'not-found' };
	const data = parseCharacterData(character.data);
	const campaignId = data.life.status === 'dead' ? data.life.campaignId : undefined;
	if (character.userId !== input.actorUserId) {
		if (!campaignId) return { ok: false, reason: 'not-found' };
		const campaign = await db
			.select({ ownerUserId: campaigns.ownerUserId })
			.from(campaigns)
			.where(and(eq(campaigns.id, campaignId), isNull(campaigns.archivedAt)))
			.get();
		if (campaign?.ownerUserId !== input.actorUserId) {
			return { ok: false, reason: 'not-found' };
		}
	}
	if (character.version !== input.expectedVersion) {
		return { ok: false, reason: 'version-conflict', currentVersion: character.version };
	}
	if (data.life.status !== 'dead') return { ok: false, reason: 'not-dead' };

	const now = input.now ?? new Date();
	const claimId = nanoid();
	const resultingVersion = input.expectedVersion + 1;
	data.life = { status: 'alive' };
	const statements: CampaignAtomicStatement[] = [
		characterLifeClaim(db, {
			claimId,
			kind: 'character.death-corrected',
			characterId: input.characterId,
			actorUserId: input.actorUserId,
			expectedVersion: input.expectedVersion,
			expectedLifeStatus: 'dead',
			campaignId,
			tenure: undefined,
			now,
			sessionGuard: sql`1 = 1`
		}),
		db.insert(characterVersionClaims).values({
			characterId: input.characterId,
			resultingVersion,
			mutationKind: 'death-corrected',
			actorUserId: input.actorUserId,
			createdAt: now
		}),
		db
			.update(characters)
			.set({
				data: JSON.stringify(data),
				lifeStatus: 'alive',
				version: resultingVersion,
				updatedAt: now
			})
			.where(
				and(
					eq(characters.id, input.characterId),
					eq(characters.version, input.expectedVersion)
				)
			)
	];
	if (campaignId) {
		statements.push(
			db.insert(campaignEvents).values({
				campaignId,
				characterId: input.characterId,
				actorUserId: input.actorUserId,
				kind: 'adventurer.death-corrected',
				publicPayloadJson: JSON.stringify({ characterId: input.characterId }),
				createdAt: now
			})
		);
	}
	statements.push(mutationClaimReceipt(db, claimId));

	try {
		await runCampaignAtomic(db, statements);
	} catch (cause) {
		const failure = await classifyDeathCorrectionWriteFailure(db, {
			characterId: input.characterId,
			actorUserId: input.actorUserId,
			expectedVersion: input.expectedVersion,
			campaignId
		});
		if (failure) return failure;
		throw cause;
	}
	return { ok: true, version: resultingVersion };
}

function characterLifeClaim(
	db: AppDb,
	input: {
		claimId: string;
		kind: string;
		characterId: string;
		actorUserId: string;
		expectedVersion: number;
		expectedLifeStatus: 'alive' | 'dead';
		campaignId: string | undefined;
		tenure: Awaited<ReturnType<typeof readActiveTenureContext>>;
		now: Date;
		sessionGuard: SQL;
	}
): CampaignAtomicStatement {
	const tenureGuard = input.tenure
		? exists(
				db
					.select({ id: campaignAdventurerTenures.id })
					.from(campaignAdventurerTenures)
					.innerJoin(
						campaignMembers,
						eq(campaignMembers.id, campaignAdventurerTenures.membershipId)
					)
					.innerJoin(campaigns, eq(campaigns.id, campaignAdventurerTenures.campaignId))
					.where(
						and(
							eq(campaignAdventurerTenures.id, input.tenure.id),
							eq(campaignAdventurerTenures.characterId, input.characterId),
							eq(campaignAdventurerTenures.campaignId, input.tenure.campaignId),
							eq(campaignAdventurerTenures.membershipId, input.tenure.membershipId),
							isNull(campaignAdventurerTenures.endedAt),
							isNull(campaignMembers.leftAt),
							isNull(campaignMembers.removedAt),
							isNull(campaigns.archivedAt)
						)
					)
			)
		: sql`1 = 1`;
	const campaignOwnerGuard = input.campaignId
		? exists(
				db
					.select({ id: campaigns.id })
					.from(campaigns)
					.where(
						and(
							eq(campaigns.id, input.campaignId),
							eq(campaigns.ownerUserId, input.actorUserId),
							isNull(campaigns.archivedAt)
						)
					)
			)
		: sql`0 = 1`;
	return db.insert(campaignMutationClaims).select(
		db
			.select({
				id: sql<string>`${input.claimId}`.as('id'),
				campaignId: input.campaignId
					? sql<string>`${input.campaignId}`.as('campaign_id')
					: sql<string | null>`null`.as('campaign_id'),
				characterId: characters.id,
				kind: sql<string>`${input.kind}`.as('kind'),
				actorUserId: sql<string>`${input.actorUserId}`.as('actor_user_id'),
				createdAt: sql<Date>`${Math.floor(input.now.getTime() / 1000)}`.as('created_at')
			})
			.from(characters)
			.where(
				and(
					eq(characters.id, input.characterId),
					eq(characters.version, input.expectedVersion),
					eq(characters.lifeStatus, input.expectedLifeStatus),
					or(eq(characters.userId, input.actorUserId), campaignOwnerGuard),
					tenureGuard,
					input.sessionGuard
				)
			)
	);
}

async function readCharacter(db: AppDb, characterId: string) {
	return db
		.select({
			id: characters.id,
			userId: characters.userId,
			data: characters.data,
			version: characters.version,
			lifeStatus: characters.lifeStatus
		})
		.from(characters)
		.where(eq(characters.id, characterId))
		.get();
}

async function readActiveTenureContext(db: AppDb, characterId: string) {
	return db
		.select({
			id: campaignAdventurerTenures.id,
			campaignId: campaignAdventurerTenures.campaignId,
			membershipId: campaignAdventurerTenures.membershipId,
			campaignOwnerUserId: campaigns.ownerUserId
		})
		.from(campaignAdventurerTenures)
		.innerJoin(campaignMembers, eq(campaignMembers.id, campaignAdventurerTenures.membershipId))
		.innerJoin(campaigns, eq(campaigns.id, campaignAdventurerTenures.campaignId))
		.where(
			and(
				eq(campaignAdventurerTenures.characterId, characterId),
				isNull(campaignAdventurerTenures.endedAt),
				isNull(campaignMembers.leftAt),
				isNull(campaignMembers.removedAt),
				isNull(campaigns.archivedAt)
			)
		)
		.get();
}

function parseCharacterData(raw: string) {
	try {
		return migrateCharacterData(JSON.parse(raw));
	} catch {
		return migrateCharacterData(null);
	}
}

async function classifyDeathWriteFailure(
	db: AppDb,
	input: {
		characterId: string;
		actorUserId: string;
		expectedVersion: number;
		campaignId: string | undefined;
		observedTenure: Awaited<ReturnType<typeof readActiveTenureContext>>;
		observedSessionId: string | null;
		sessionState: SessionStatePort;
	}
): Promise<CharacterLifeMutationResult | null> {
	const current = await readCharacter(db, input.characterId);
	if (!current) return { ok: false, reason: 'not-found' };
	const currentTenure = await readActiveTenureContext(db, input.characterId);
	if (
		(input.campaignId && currentTenure?.campaignId !== input.campaignId) ||
		(current.userId !== input.actorUserId &&
			currentTenure?.campaignOwnerUserId !== input.actorUserId)
	) {
		return { ok: false, reason: 'not-found' };
	}
	if (current.version !== input.expectedVersion) {
		return { ok: false, reason: 'version-conflict', currentVersion: current.version };
	}
	const currentSessionId = input.campaignId
		? await input.sessionState.activeSessionId(input.campaignId)
		: null;
	if (
		current.lifeStatus !== 'alive' ||
		!sameTenure(currentTenure, input.observedTenure) ||
		currentSessionId !== input.observedSessionId
	) {
		return { ok: false, reason: 'conflict' };
	}
	return null;
}

async function classifyDeathCorrectionWriteFailure(
	db: AppDb,
	input: {
		characterId: string;
		actorUserId: string;
		expectedVersion: number;
		campaignId: string | undefined;
	}
): Promise<CharacterLifeMutationResult | null> {
	const current = await readCharacter(db, input.characterId);
	if (!current) return { ok: false, reason: 'not-found' };
	if (current.userId !== input.actorUserId) {
		if (!input.campaignId) return { ok: false, reason: 'not-found' };
		const campaign = await db
			.select({ ownerUserId: campaigns.ownerUserId })
			.from(campaigns)
			.where(and(eq(campaigns.id, input.campaignId), isNull(campaigns.archivedAt)))
			.get();
		if (campaign?.ownerUserId !== input.actorUserId) {
			return { ok: false, reason: 'not-found' };
		}
	}
	if (current.version !== input.expectedVersion) {
		return { ok: false, reason: 'version-conflict', currentVersion: current.version };
	}
	if (current.lifeStatus !== 'dead') return { ok: false, reason: 'conflict' };
	return null;
}

function sameTenure(
	current: Awaited<ReturnType<typeof readActiveTenureContext>>,
	observed: Awaited<ReturnType<typeof readActiveTenureContext>>
): boolean {
	return (
		current?.id === observed?.id &&
		current?.campaignId === observed?.campaignId &&
		current?.membershipId === observed?.membershipId &&
		current?.campaignOwnerUserId === observed?.campaignOwnerUserId
	);
}
