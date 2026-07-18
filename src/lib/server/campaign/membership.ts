import { and, eq, exists, isNull, ne, notExists, sql, type SQL } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { AppDb } from '$lib/server/db';
import {
	campaignAdventurerTenures,
	campaignEvents,
	campaignMembers,
	campaignMutationClaims,
	campaigns
} from '$lib/server/db/schema';
import {
	sha256Hex,
	verifyInviteToken
} from './invites';
import { assertCampaignMembershipAllowed } from './membership-rules';
import {
	characterEligibilityClaim,
	readAdventurerEligibility,
	type EligibilityFailure
} from './tenure';
import {
	mutationClaimReceipt,
	runCampaignAtomic,
	type CampaignAtomicStatement
} from './atomic';
import {
	noSessionsYet,
	type SessionCleanupPort,
	type SessionStatePort
} from './session-state-port';

export type JoinCampaignResult =
	| {
			ok: true;
			campaignId: string;
			membershipId: string;
			tenureId?: string;
			created: boolean;
			observer: boolean;
	  }
	| {
			ok: false;
			reason: EligibilityFailure | 'invalid-invite' | 'join-mode-required' | 'conflict';
	  };

/** Validate an invitation for a signed-in user without creating membership state. */
export async function previewCampaignInvite(
	db: AppDb,
	input: { token: string; secret: string; userId: string }
): Promise<{ campaignId: string; name: string } | null> {
	const campaign = await readValidInvite(db, input.token, input.secret);
	if (!campaign) return null;
	try {
		assertCampaignMembershipAllowed(campaign.ownerUserId, input.userId);
	} catch {
		return null;
	}
	return { campaignId: campaign.id, name: campaign.name };
}

export async function joinCampaignWithInvite(
	db: AppDb,
	input: {
		token: string;
		secret: string;
		userId: string;
		membershipId?: string;
		characterId?: string;
		joinWithoutCharacter?: boolean;
		tenureId?: string;
		now?: Date;
	},
	sessionState: SessionStatePort = noSessionsYet
): Promise<JoinCampaignResult> {
	if (!input.characterId && input.joinWithoutCharacter !== true) {
		return { ok: false, reason: 'join-mode-required' };
	}

	const campaign = await readValidInvite(db, input.token, input.secret);
	if (!campaign) return { ok: false, reason: 'invalid-invite' };
	try {
		assertCampaignMembershipAllowed(campaign.ownerUserId, input.userId);
	} catch {
		return { ok: false, reason: 'invalid-invite' };
	}

	const existing = await readActiveMembership(db, campaign.id, input.userId);
	if (existing) {
		return {
			ok: true,
			campaignId: campaign.id,
			membershipId: existing.id,
			...(existing.tenureId ? { tenureId: existing.tenureId } : {}),
			created: false,
			observer: !existing.tenureId
		};
	}

	const activeSessionId = await sessionState.activeSessionId(campaign.id);
	const attachCharacterId = activeSessionId ? undefined : input.characterId;
	const eligibility = attachCharacterId
		? await readAdventurerEligibility(db, attachCharacterId, input.userId)
		: null;
	if (eligibility && !eligibility.ok) return eligibility;

	const membershipId = input.membershipId ?? nanoid();
	const tenureId = attachCharacterId ? (input.tenureId ?? nanoid()) : undefined;
	const inviteClaimId = nanoid();
	const characterClaimId = attachCharacterId ? nanoid() : undefined;
	const now = input.now ?? new Date();
	const statements: CampaignAtomicStatement[] = [
		invitationJoinClaim(db, {
			claimId: inviteClaimId,
			campaign,
			userId: input.userId,
			now,
			sessionGuard: sessionState.claimGuard(campaign.id, activeSessionId)
		}),
		db.insert(campaignMembers).values({
			id: membershipId,
			campaignId: campaign.id,
			userId: input.userId,
			joinedAt: now
		}),
		db.insert(campaignEvents).values({
			campaignId: campaign.id,
			membershipId,
			actorUserId: input.userId,
			kind: 'membership.joined',
			publicPayloadJson: JSON.stringify({ membershipId }),
			createdAt: now
		})
	];
	if (attachCharacterId && tenureId && characterClaimId && eligibility?.ok) {
		statements.push(
			characterEligibilityClaim(db, {
				claimId: characterClaimId,
				campaignId: campaign.id,
				characterId: attachCharacterId,
				actorUserId: input.userId,
				observedVersion: eligibility.observedVersion,
				kind: 'membership.join-attach',
				now,
				sessionGuard: sessionState.claimGuard(campaign.id, activeSessionId)
			}),
			db.insert(campaignAdventurerTenures).values({
				id: tenureId,
				campaignId: campaign.id,
				membershipId,
				characterId: attachCharacterId,
				startedAt: now,
				startedByUserId: input.userId
			}),
			db.insert(campaignEvents).values({
				campaignId: campaign.id,
				membershipId,
				tenureId,
				characterId: attachCharacterId,
				actorUserId: input.userId,
				kind: 'adventurer.attached',
				publicPayloadJson: JSON.stringify({ membershipId, characterId: attachCharacterId }),
				createdAt: now
			})
		);
	}
	statements.push(mutationClaimReceipt(db, inviteClaimId));
	if (characterClaimId) statements.push(mutationClaimReceipt(db, characterClaimId));

	try {
		await runCampaignAtomic(db, statements);
	} catch (cause) {
		const winner = await readActiveMembership(db, campaign.id, input.userId);
		if (winner) {
			return {
				ok: true,
				campaignId: campaign.id,
				membershipId: winner.id,
				...(winner.tenureId ? { tenureId: winner.tenureId } : {}),
				created: false,
				observer: !winner.tenureId
			};
		}
		const currentCampaign = await readValidInvite(db, input.token, input.secret);
		if (!currentCampaign) {
			return { ok: false, reason: 'invalid-invite' };
		}
		try {
			assertCampaignMembershipAllowed(currentCampaign.ownerUserId, input.userId);
		} catch {
			return { ok: false, reason: 'invalid-invite' };
		}
		if (currentCampaign.ownerUserId !== campaign.ownerUserId) {
			return { ok: false, reason: 'conflict' };
		}
		if (attachCharacterId) {
			const currentEligibility = await readAdventurerEligibility(
				db,
				attachCharacterId,
				input.userId
			);
			if (!currentEligibility.ok) return currentEligibility;
			if (
				!eligibility?.ok ||
				currentEligibility.observedVersion !== eligibility.observedVersion
			) {
				return { ok: false, reason: 'conflict' };
			}
		}
		if ((await sessionState.activeSessionId(campaign.id)) !== activeSessionId) {
			return { ok: false, reason: 'conflict' };
		}
		throw cause;
	}

	return {
		ok: true,
		campaignId: campaign.id,
		membershipId,
		...(tenureId ? { tenureId } : {}),
		created: true,
		observer: !tenureId
	};
}

function invitationJoinClaim(
	db: AppDb,
	input: {
		claimId: string;
		campaign: NonNullable<Awaited<ReturnType<typeof readValidInvite>>>;
		userId: string;
		now: Date;
		sessionGuard: SQL;
	}
): CampaignAtomicStatement {
	return db.insert(campaignMutationClaims).select(
		db
			.select({
				id: sql<string>`${input.claimId}`.as('id'),
				campaignId: campaigns.id,
				characterId: sql<string | null>`null`.as('character_id'),
				kind: sql<string>`'membership.join'`.as('kind'),
				actorUserId: sql<string>`${input.userId}`.as('actor_user_id'),
				createdAt: sql<Date>`${Math.floor(input.now.getTime() / 1000)}`.as('created_at')
			})
			.from(campaigns)
			.where(
				and(
					eq(campaigns.id, input.campaign.id),
					eq(campaigns.ownerUserId, input.campaign.ownerUserId),
					ne(campaigns.ownerUserId, input.userId),
					eq(campaigns.inviteTokenHash, input.campaign.inviteTokenHash),
					eq(campaigns.inviteTokenPrefix, input.campaign.inviteTokenPrefix),
					eq(campaigns.inviteNonce, input.campaign.inviteNonce),
					eq(campaigns.inviteVersion, input.campaign.inviteVersion),
					eq(campaigns.joinOpen, true),
					isNull(campaigns.archivedAt),
					notExists(
						db
							.select({ id: campaignMembers.id })
							.from(campaignMembers)
							.where(
								and(
									eq(campaignMembers.campaignId, input.campaign.id),
									eq(campaignMembers.userId, input.userId),
									isNull(campaignMembers.leftAt)
								)
							)
					),
					input.sessionGuard
				)
			)
	);
}

async function readValidInvite(db: AppDb, token: string, secret: string) {
	const claims = await verifyInviteToken(token, secret);
	if (!claims) return null;
	const tokenHash = await sha256Hex(token);
	const row = await db
		.select({
			id: campaigns.id,
			name: campaigns.name,
			ownerUserId: campaigns.ownerUserId,
			inviteTokenHash: campaigns.inviteTokenHash,
			inviteTokenPrefix: campaigns.inviteTokenPrefix,
			inviteNonce: campaigns.inviteNonce,
			inviteVersion: campaigns.inviteVersion
		})
		.from(campaigns)
		.where(
			and(
				eq(campaigns.id, claims.campaignId),
				eq(campaigns.inviteTokenPrefix, tokenHash.slice(0, 16)),
				eq(campaigns.joinOpen, true),
				isNull(campaigns.archivedAt)
			)
		)
		.get();
	if (
		!row ||
		row.inviteTokenHash !== tokenHash ||
		row.inviteVersion !== claims.version ||
		row.inviteNonce !== claims.nonce
	) {
		return null;
	}
	return {
		...row,
		inviteTokenHash: row.inviteTokenHash!,
		inviteTokenPrefix: row.inviteTokenPrefix!,
		inviteNonce: row.inviteNonce!
	};
}

async function readActiveMembership(db: AppDb, campaignId: string, userId: string) {
	return db
		.select({ id: campaignMembers.id, tenureId: campaignAdventurerTenures.id })
		.from(campaignMembers)
		.leftJoin(
			campaignAdventurerTenures,
			and(
				eq(campaignAdventurerTenures.membershipId, campaignMembers.id),
				isNull(campaignAdventurerTenures.endedAt)
			)
		)
		.where(
			and(
				eq(campaignMembers.campaignId, campaignId),
				eq(campaignMembers.userId, userId),
				isNull(campaignMembers.leftAt),
				isNull(campaignMembers.removedAt)
			)
		)
		.get();
}

export type MembershipDepartureResult =
	| {
			ok: true;
			membershipId: string;
			endedTenureId?: string;
			sessionId?: string;
	  }
	| { ok: false; reason: 'not-found' | 'session-cleanup-unavailable' | 'conflict' };

interface MembershipMutationPorts {
	sessionState?: SessionStatePort;
	sessionCleanup?: SessionCleanupPort;
}

export async function leaveCampaign(
	db: AppDb,
	input: {
		campaignId: string;
		membershipId: string;
		userId: string;
		now?: Date;
	},
	ports: MembershipMutationPorts = {}
): Promise<MembershipDepartureResult> {
	return departCampaign(db, {
		kind: 'leave',
		campaignId: input.campaignId,
		membershipId: input.membershipId,
		actorUserId: input.userId,
		expectedMemberUserId: input.userId,
		now: input.now
	}, ports);
}

export async function removeCampaignMember(
	db: AppDb,
	input: {
		campaignId: string;
		membershipId: string;
		ownerUserId: string;
		now?: Date;
	},
	ports: MembershipMutationPorts = {}
): Promise<MembershipDepartureResult> {
	return departCampaign(db, {
		kind: 'remove',
		campaignId: input.campaignId,
		membershipId: input.membershipId,
		actorUserId: input.ownerUserId,
		expectedOwnerUserId: input.ownerUserId,
		now: input.now
	}, ports);
}

async function departCampaign(
	db: AppDb,
	input: {
		kind: 'leave' | 'remove';
		campaignId: string;
		membershipId: string;
		actorUserId: string;
		expectedMemberUserId?: string;
		expectedOwnerUserId?: string;
		now?: Date;
	},
	ports: MembershipMutationPorts
): Promise<MembershipDepartureResult> {
	const membership = await readDepartureContext(db, input.campaignId, input.membershipId);
	if (!membership) return { ok: false, reason: 'not-found' };
	if (
		(input.expectedMemberUserId && membership.userId !== input.expectedMemberUserId) ||
		(input.expectedOwnerUserId && membership.ownerUserId !== input.expectedOwnerUserId)
	) {
		return { ok: false, reason: 'not-found' };
	}

	const sessionState = ports.sessionState ?? noSessionsYet;
	const sessionId = await sessionState.activeSessionId(input.campaignId);
	let cleanupStatements: CampaignAtomicStatement[] = [];
	if (sessionId) {
		if (!ports.sessionCleanup) {
			return { ok: false, reason: 'session-cleanup-unavailable' };
		}
		cleanupStatements = await ports.sessionCleanup.statements(db, {
			kind: input.kind,
			campaignId: input.campaignId,
			sessionId,
			membershipId: input.membershipId,
			tenureId: membership.tenureId,
			characterId: membership.characterId,
			actorUserId: input.actorUserId
		});
	}

	const now = input.now ?? new Date();
	const claimId = nanoid();
	const statements: CampaignAtomicStatement[] = [
		departureClaim(db, {
			claimId,
			kind: input.kind,
			campaignId: input.campaignId,
			membershipId: input.membershipId,
			actorUserId: input.actorUserId,
			expectedMemberUserId: input.expectedMemberUserId,
			expectedOwnerUserId: input.expectedOwnerUserId,
			expectedActiveTenureId: membership.tenureId,
			now,
			sessionGuard: sessionState.claimGuard(input.campaignId, sessionId)
		}),
		db
			.update(campaignMembers)
			.set(
				input.kind === 'remove'
					? { leftAt: now, removedAt: now, removedByUserId: input.actorUserId }
					: { leftAt: now }
			)
			.where(
				and(
					eq(campaignMembers.id, input.membershipId),
					isNull(campaignMembers.leftAt),
					isNull(campaignMembers.removedAt)
				)
			)
	];
	if (membership.tenureId) {
		statements.push(
			db
				.update(campaignAdventurerTenures)
				.set({
					endedAt: now,
					endedByUserId: input.actorUserId,
					endReason: input.kind === 'remove' ? 'removed' : 'left'
				})
				.where(
					and(
						eq(campaignAdventurerTenures.id, membership.tenureId),
						isNull(campaignAdventurerTenures.endedAt)
					)
				)
		);
	}
	statements.push(
		...cleanupStatements,
		db.insert(campaignEvents).values({
			campaignId: input.campaignId,
			membershipId: input.membershipId,
			...(membership.tenureId ? { tenureId: membership.tenureId } : {}),
			...(membership.characterId ? { characterId: membership.characterId } : {}),
			actorUserId: input.actorUserId,
			kind: input.kind === 'remove' ? 'membership.removed' : 'membership.left',
			publicPayloadJson: JSON.stringify({ membershipId: input.membershipId }),
			createdAt: now
		}),
		mutationClaimReceipt(db, claimId)
	);

	try {
		await runCampaignAtomic(db, statements);
	} catch (cause) {
		const current = await readDepartureContext(db, input.campaignId, input.membershipId);
		const currentSessionId = await sessionState.activeSessionId(input.campaignId);
		if (
			!current ||
			current.userId !== membership.userId ||
			current.ownerUserId !== membership.ownerUserId ||
			current.tenureId !== membership.tenureId ||
			current.characterId !== membership.characterId ||
			currentSessionId !== sessionId
		) {
			return { ok: false, reason: 'conflict' };
		}
		throw cause;
	}
	return {
		ok: true,
		membershipId: input.membershipId,
		...(membership.tenureId ? { endedTenureId: membership.tenureId } : {}),
		...(sessionId ? { sessionId } : {})
	};
}

async function readDepartureContext(db: AppDb, campaignId: string, membershipId: string) {
	return db
		.select({
			id: campaignMembers.id,
			userId: campaignMembers.userId,
			ownerUserId: campaigns.ownerUserId,
			tenureId: campaignAdventurerTenures.id,
			characterId: campaignAdventurerTenures.characterId
		})
		.from(campaignMembers)
		.innerJoin(campaigns, eq(campaigns.id, campaignMembers.campaignId))
		.leftJoin(
			campaignAdventurerTenures,
			and(
				eq(campaignAdventurerTenures.membershipId, campaignMembers.id),
				isNull(campaignAdventurerTenures.endedAt)
			)
		)
		.where(
			and(
				eq(campaignMembers.id, membershipId),
				eq(campaignMembers.campaignId, campaignId),
				isNull(campaignMembers.leftAt),
				isNull(campaignMembers.removedAt),
				isNull(campaigns.archivedAt)
			)
		)
		.get();
}

function departureClaim(
	db: AppDb,
	input: {
		claimId: string;
		kind: 'leave' | 'remove';
		campaignId: string;
		membershipId: string;
		actorUserId: string;
		expectedMemberUserId?: string;
		expectedOwnerUserId?: string;
		expectedActiveTenureId: string | null;
		now: Date;
		sessionGuard: SQL;
	}
): CampaignAtomicStatement {
	const tenureGuard = input.expectedActiveTenureId
		? exists(
				db
					.select({ id: campaignAdventurerTenures.id })
					.from(campaignAdventurerTenures)
					.where(
						and(
							eq(campaignAdventurerTenures.id, input.expectedActiveTenureId),
							eq(campaignAdventurerTenures.membershipId, input.membershipId),
							isNull(campaignAdventurerTenures.endedAt)
						)
					)
			)
		: notExists(
				db
					.select({ id: campaignAdventurerTenures.id })
					.from(campaignAdventurerTenures)
					.where(
						and(
							eq(campaignAdventurerTenures.membershipId, input.membershipId),
							isNull(campaignAdventurerTenures.endedAt)
						)
					)
			);
	return db.insert(campaignMutationClaims).select(
		db
			.select({
				id: sql<string>`${input.claimId}`.as('id'),
				campaignId: campaignMembers.campaignId,
				characterId: sql<string | null>`null`.as('character_id'),
				kind: sql<string>`${input.kind === 'remove' ? 'membership.remove' : 'membership.leave'}`.as('kind'),
				actorUserId: sql<string>`${input.actorUserId}`.as('actor_user_id'),
				createdAt: sql<Date>`${Math.floor(input.now.getTime() / 1000)}`.as('created_at')
			})
			.from(campaignMembers)
			.innerJoin(campaigns, eq(campaigns.id, campaignMembers.campaignId))
			.where(
				and(
					eq(campaignMembers.id, input.membershipId),
					eq(campaignMembers.campaignId, input.campaignId),
					input.expectedMemberUserId
						? eq(campaignMembers.userId, input.expectedMemberUserId)
						: sql`1 = 1`,
					input.expectedOwnerUserId
						? eq(campaigns.ownerUserId, input.expectedOwnerUserId)
						: sql`1 = 1`,
					isNull(campaignMembers.leftAt),
					isNull(campaignMembers.removedAt),
					isNull(campaigns.archivedAt),
					tenureGuard,
					input.sessionGuard
				)
			)
	);
}

export async function archiveCampaign(
	db: AppDb,
	input: { campaignId: string; ownerUserId: string; now?: Date },
	sessionState: SessionStatePort = noSessionsYet
): Promise<{ ok: true } | { ok: false; reason: 'not-found' | 'session-active' | 'conflict' }> {
	const campaign = await db
		.select({ version: campaigns.version })
		.from(campaigns)
		.where(
			and(
				eq(campaigns.id, input.campaignId),
				eq(campaigns.ownerUserId, input.ownerUserId),
				isNull(campaigns.archivedAt)
			)
		)
		.get();
	if (!campaign) return { ok: false, reason: 'not-found' };
	const activeSessionId = await sessionState.activeSessionId(input.campaignId);
	if (activeSessionId) {
		return { ok: false, reason: 'session-active' };
	}

	const now = input.now ?? new Date();
	const claimId = nanoid();
	try {
		await runCampaignAtomic(db, [
			db.insert(campaignMutationClaims).select(
				db
					.select({
						id: sql<string>`${claimId}`.as('id'),
						campaignId: campaigns.id,
						characterId: sql<string | null>`null`.as('character_id'),
						kind: sql<string>`'campaign.archive'`.as('kind'),
						actorUserId: sql<string>`${input.ownerUserId}`.as('actor_user_id'),
						createdAt: sql<Date>`${Math.floor(now.getTime() / 1000)}`.as('created_at')
					})
					.from(campaigns)
					.where(
						and(
							eq(campaigns.id, input.campaignId),
							eq(campaigns.ownerUserId, input.ownerUserId),
							eq(campaigns.version, campaign.version),
							isNull(campaigns.archivedAt),
							sessionState.claimGuard(input.campaignId, activeSessionId)
						)
					)
			),
			db
				.update(campaigns)
				.set({
					archivedAt: now,
					joinOpen: false,
					version: campaign.version + 1,
					updatedAt: now
				})
				.where(
					and(
						eq(campaigns.id, input.campaignId),
						eq(campaigns.ownerUserId, input.ownerUserId),
						eq(campaigns.version, campaign.version),
						isNull(campaigns.archivedAt)
					)
				),
			db.insert(campaignEvents).values({
				campaignId: input.campaignId,
				actorUserId: input.ownerUserId,
				kind: 'campaign.archived',
				publicPayloadJson: '{}',
				createdAt: now
			}),
			mutationClaimReceipt(db, claimId)
		]);
	} catch (cause) {
		const current = await db
			.select({
				ownerUserId: campaigns.ownerUserId,
				version: campaigns.version,
				archivedAt: campaigns.archivedAt
			})
			.from(campaigns)
			.where(eq(campaigns.id, input.campaignId))
			.get();
		if (!current || current.ownerUserId !== input.ownerUserId) {
			return { ok: false, reason: 'not-found' };
		}
		if (
			current.version !== campaign.version ||
			current.archivedAt !== null ||
			(await sessionState.activeSessionId(input.campaignId)) !== activeSessionId
		) {
			return { ok: false, reason: 'conflict' };
		}
		throw cause;
	}
	return { ok: true };
}
