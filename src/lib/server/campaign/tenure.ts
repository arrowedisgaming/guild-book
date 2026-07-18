import { and, desc, eq, exists, isNull, notExists, sql, type SQL } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { AppDb } from '$lib/server/db';
import {
	campaignAdventurerTenures,
	campaignEvents,
	campaignMembers,
	campaignMutationClaims,
	campaigns,
	characters
} from '$lib/server/db/schema';
import { migrateCharacterData } from '$lib/engine/character-migration';
import {
	mutationClaimReceipt,
	runCampaignAtomic,
	type CampaignAtomicStatement
} from './atomic';
import { noSessionsYet, type SessionStatePort } from './session-state-port';

export interface AdventurerEligibilityFacts {
	ownedByActor: boolean;
	finalized: boolean;
	lifeStatus: 'alive' | 'dead';
	archived: boolean;
	hasActiveTenure: boolean;
}

export type EligibilityFailure =
	| 'not-owner'
	| 'draft'
	| 'dead'
	| 'archived'
	| 'already-attached';

export type AdventurerEligibilityResult =
	| { ok: true }
	| { ok: false; reason: EligibilityFailure };

/** Apply the canonical adventurer attachment rules in a stable failure order. */
export function evaluateAdventurerEligibility(
	facts: AdventurerEligibilityFacts
): AdventurerEligibilityResult {
	if (!facts.ownedByActor) return { ok: false, reason: 'not-owner' };
	if (!facts.finalized) return { ok: false, reason: 'draft' };
	if (facts.lifeStatus === 'dead') return { ok: false, reason: 'dead' };
	if (facts.archived) return { ok: false, reason: 'archived' };
	if (facts.hasActiveTenure) return { ok: false, reason: 'already-attached' };
	return { ok: true };
}

type ReadAdventurerEligibilityResult =
	| { ok: true; observedVersion: number }
	| { ok: false; reason: EligibilityFailure };

export function characterEligibilityClaim(
	db: AppDb,
	input: {
		claimId: string;
		campaignId: string;
		characterId: string;
		actorUserId: string;
		observedVersion: number;
		kind: string;
		now: Date;
		sessionGuard: SQL;
		membership?: { id: string; expectedActiveTenureId: string | null };
	}
): CampaignAtomicStatement {
	const membershipGuard = input.membership
		? exists(
				db
					.select({ id: campaignMembers.id })
					.from(campaignMembers)
					.innerJoin(campaigns, eq(campaigns.id, campaignMembers.campaignId))
					.where(
						and(
							eq(campaignMembers.id, input.membership.id),
							eq(campaignMembers.campaignId, input.campaignId),
							eq(campaignMembers.userId, input.actorUserId),
							isNull(campaignMembers.leftAt),
							isNull(campaignMembers.removedAt),
							isNull(campaigns.archivedAt)
						)
					)
			)
		: sql`1 = 1`;
	const membershipTenureGuard = !input.membership
		? sql`1 = 1`
		: input.membership.expectedActiveTenureId
			? exists(
					db
						.select({ id: campaignAdventurerTenures.id })
						.from(campaignAdventurerTenures)
						.where(
							and(
								eq(
									campaignAdventurerTenures.id,
									input.membership.expectedActiveTenureId
								),
								eq(campaignAdventurerTenures.membershipId, input.membership.id),
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
								eq(campaignAdventurerTenures.membershipId, input.membership.id),
								isNull(campaignAdventurerTenures.endedAt)
							)
						)
				);

	return db.insert(campaignMutationClaims).select(
		db
			.select({
				id: sql<string>`${input.claimId}`.as('id'),
				campaignId: sql<string>`${input.campaignId}`.as('campaign_id'),
				characterId: characters.id,
				kind: sql<string>`${input.kind}`.as('kind'),
				actorUserId: sql<string>`${input.actorUserId}`.as('actor_user_id'),
				createdAt: sql<Date>`${Math.floor(input.now.getTime() / 1000)}`.as('created_at')
			})
			.from(characters)
			.where(
				and(
					eq(characters.id, input.characterId),
					eq(characters.userId, input.actorUserId),
					eq(characters.version, input.observedVersion),
					eq(characters.lifeStatus, 'alive'),
					eq(characters.isDraft, false),
					eq(characters.isArchived, false),
					notExists(
						db
							.select({ id: campaignAdventurerTenures.id })
							.from(campaignAdventurerTenures)
							.where(
								and(
									eq(campaignAdventurerTenures.characterId, input.characterId),
									isNull(campaignAdventurerTenures.endedAt)
								)
							)
					),
					membershipGuard,
					membershipTenureGuard,
					input.sessionGuard
				)
			)
	);
}

export type AttachAdventurerResult =
	| { ok: true; tenureId: string }
	| {
			ok: false;
			reason:
				| EligibilityFailure
				| 'membership-not-found'
				| 'membership-has-adventurer'
				| 'session-active'
				| 'conflict';
	  };

export async function attachAdventurer(
	db: AppDb,
	input: {
		campaignId: string;
		membershipId: string;
		actorUserId: string;
		characterId: string;
		tenureId?: string;
		now?: Date;
	},
	sessionState: SessionStatePort = noSessionsYet
): Promise<AttachAdventurerResult> {
	const membership = await readActiveMembership(
		db,
		input.campaignId,
		input.membershipId,
		input.actorUserId
	);
	if (!membership) return { ok: false, reason: 'membership-not-found' };

	const membershipTenure = await readActiveMembershipTenure(db, input.membershipId);
	if (membershipTenure) return { ok: false, reason: 'membership-has-adventurer' };

	const eligibility = await readAdventurerEligibility(db, input.characterId, input.actorUserId);
	if (!eligibility.ok) return eligibility;

	const activeSessionId = await sessionState.activeSessionId(input.campaignId);
	if (activeSessionId) {
		const latestTenure = await db
			.select({ endReason: campaignAdventurerTenures.endReason, deathSessionId: campaignAdventurerTenures.deathSessionId })
			.from(campaignAdventurerTenures)
			.where(eq(campaignAdventurerTenures.membershipId, input.membershipId))
			.orderBy(desc(campaignAdventurerTenures.endedAt))
			.get();
		if (
			latestTenure?.endReason !== 'died' ||
			latestTenure.deathSessionId !== activeSessionId
		) {
			return { ok: false, reason: 'session-active' };
		}
	}

	const tenureId = input.tenureId ?? nanoid();
	const claimId = nanoid();
	const now = input.now ?? new Date();
	try {
		await runCampaignAtomic(db, [
			characterEligibilityClaim(db, {
				claimId,
				campaignId: input.campaignId,
				characterId: input.characterId,
				actorUserId: input.actorUserId,
				observedVersion: eligibility.observedVersion,
				kind: 'adventurer.attach',
				now,
				sessionGuard: sessionState.claimGuard(input.campaignId, activeSessionId),
				membership: { id: input.membershipId, expectedActiveTenureId: null }
			}),
			db.insert(campaignAdventurerTenures).values({
				id: tenureId,
				campaignId: input.campaignId,
				membershipId: input.membershipId,
				characterId: input.characterId,
				startedAt: now,
				startedByUserId: input.actorUserId
			}),
			db.insert(campaignEvents).values({
				campaignId: input.campaignId,
				membershipId: input.membershipId,
				tenureId,
				characterId: input.characterId,
				actorUserId: input.actorUserId,
				kind: 'adventurer.attached',
				publicPayloadJson: JSON.stringify({
					membershipId: input.membershipId,
					characterId: input.characterId
				}),
				createdAt: now
			}),
			mutationClaimReceipt(db, claimId)
		]);
	} catch (cause) {
		if (
			!(await readActiveMembership(
				db,
				input.campaignId,
				input.membershipId,
				input.actorUserId
			))
		) {
			return { ok: false, reason: 'conflict' };
		}
		const currentEligibility = await readAdventurerEligibility(
			db,
			input.characterId,
			input.actorUserId
		);
		if (!currentEligibility.ok) return currentEligibility;
		if (currentEligibility.observedVersion !== eligibility.observedVersion) {
			return { ok: false, reason: 'conflict' };
		}
		if (await readActiveMembershipTenure(db, input.membershipId)) {
			return { ok: false, reason: 'membership-has-adventurer' };
		}
		if ((await sessionState.activeSessionId(input.campaignId)) !== activeSessionId) {
			return { ok: false, reason: 'conflict' };
		}
		throw cause;
	}

	return { ok: true, tenureId };
}

export type ReplaceAdventurerResult =
	| { ok: true; tenureId: string; replacedTenureId: string }
	| {
			ok: false;
			reason:
				| EligibilityFailure
				| 'membership-not-found'
				| 'no-active-adventurer'
				| 'session-active'
				| 'conflict';
	  };

export async function replaceAdventurer(
	db: AppDb,
	input: {
		campaignId: string;
		membershipId: string;
		actorUserId: string;
		characterId: string;
		tenureId?: string;
		now?: Date;
	},
	sessionState: SessionStatePort = noSessionsYet
): Promise<ReplaceAdventurerResult> {
	const membership = await readActiveMembership(
		db,
		input.campaignId,
		input.membershipId,
		input.actorUserId
	);
	if (!membership) return { ok: false, reason: 'membership-not-found' };
	const activeSessionId = await sessionState.activeSessionId(input.campaignId);
	if (activeSessionId) {
		return { ok: false, reason: 'session-active' };
	}

	const currentTenure = await readActiveMembershipTenure(db, input.membershipId);
	if (!currentTenure) return { ok: false, reason: 'no-active-adventurer' };
	const eligibility = await readAdventurerEligibility(db, input.characterId, input.actorUserId);
	if (!eligibility.ok) return eligibility;

	const tenureId = input.tenureId ?? nanoid();
	const claimId = nanoid();
	const now = input.now ?? new Date();
	try {
		await runCampaignAtomic(db, [
			characterEligibilityClaim(db, {
				claimId,
				campaignId: input.campaignId,
				characterId: input.characterId,
				actorUserId: input.actorUserId,
				observedVersion: eligibility.observedVersion,
				kind: 'adventurer.replace',
				now,
				sessionGuard: sessionState.claimGuard(input.campaignId, activeSessionId),
				membership: {
					id: input.membershipId,
					expectedActiveTenureId: currentTenure.id
				}
			}),
			db
				.update(campaignAdventurerTenures)
				.set({
					endedAt: now,
					endedByUserId: input.actorUserId,
					endReason: 'replaced'
				})
				.where(
					and(
						eq(campaignAdventurerTenures.id, currentTenure.id),
						isNull(campaignAdventurerTenures.endedAt)
					)
				),
			db.insert(campaignAdventurerTenures).values({
				id: tenureId,
				campaignId: input.campaignId,
				membershipId: input.membershipId,
				characterId: input.characterId,
				startedAt: now,
				startedByUserId: input.actorUserId
			}),
			db.insert(campaignEvents).values({
				campaignId: input.campaignId,
				membershipId: input.membershipId,
				tenureId,
				characterId: input.characterId,
				actorUserId: input.actorUserId,
				kind: 'adventurer.replaced',
				publicPayloadJson: JSON.stringify({
					membershipId: input.membershipId,
					previousTenureId: currentTenure.id,
					characterId: input.characterId
				}),
				createdAt: now
			}),
			mutationClaimReceipt(db, claimId)
		]);
	} catch (cause) {
		if (
			!(await readActiveMembership(
				db,
				input.campaignId,
				input.membershipId,
				input.actorUserId
			))
		) {
			return { ok: false, reason: 'conflict' };
		}
		const currentEligibility = await readAdventurerEligibility(
			db,
			input.characterId,
			input.actorUserId
		);
		if (!currentEligibility.ok) return currentEligibility;
		if (currentEligibility.observedVersion !== eligibility.observedVersion) {
			return { ok: false, reason: 'conflict' };
		}
		if ((await readActiveMembershipTenure(db, input.membershipId))?.id !== currentTenure.id) {
			return { ok: false, reason: 'conflict' };
		}
		if ((await sessionState.activeSessionId(input.campaignId)) !== activeSessionId) {
			return { ok: false, reason: 'conflict' };
		}
		throw cause;
	}

	return { ok: true, tenureId, replacedTenureId: currentTenure.id };
}

async function readActiveMembership(
	db: AppDb,
	campaignId: string,
	membershipId: string,
	userId: string
) {
	return db
		.select({ id: campaignMembers.id })
		.from(campaignMembers)
		.innerJoin(campaigns, eq(campaigns.id, campaignMembers.campaignId))
		.where(
			and(
				eq(campaignMembers.id, membershipId),
				eq(campaignMembers.campaignId, campaignId),
				eq(campaignMembers.userId, userId),
				isNull(campaignMembers.leftAt),
				isNull(campaignMembers.removedAt),
				isNull(campaigns.archivedAt)
			)
		)
		.get();
}

async function readActiveMembershipTenure(db: AppDb, membershipId: string) {
	return db
		.select({ id: campaignAdventurerTenures.id })
		.from(campaignAdventurerTenures)
		.where(
			and(
				eq(campaignAdventurerTenures.membershipId, membershipId),
				isNull(campaignAdventurerTenures.endedAt)
			)
		)
		.get();
}

export async function readAdventurerEligibility(
	db: AppDb,
	characterId: string,
	actorUserId: string
): Promise<ReadAdventurerEligibilityResult> {
	const character = await db
		.select({
			userId: characters.userId,
			data: characters.data,
			isArchived: characters.isArchived,
			version: characters.version
		})
		.from(characters)
		.where(eq(characters.id, characterId))
		.get();
	if (!character) return { ok: false, reason: 'not-owner' };

	let migrated;
	try {
		migrated = migrateCharacterData(JSON.parse(character.data));
	} catch {
		migrated = migrateCharacterData(null);
	}
	const activeTenure = await db
		.select({ id: campaignAdventurerTenures.id })
		.from(campaignAdventurerTenures)
		.where(
			and(
				eq(campaignAdventurerTenures.characterId, characterId),
				isNull(campaignAdventurerTenures.endedAt)
			)
		)
		.get();

	const eligibility = evaluateAdventurerEligibility({
		ownedByActor: character.userId === actorUserId,
		finalized: !migrated.isDraft,
		lifeStatus: migrated.life.status,
		archived: character.isArchived,
		hasActiveTenure: Boolean(activeTenure)
	});
	return eligibility.ok ? { ok: true, observedVersion: character.version } : eligibility;
}
