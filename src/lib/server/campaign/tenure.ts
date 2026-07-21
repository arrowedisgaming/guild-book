import { and, desc, eq, exists, isNull, notExists, sql, type SQL } from 'drizzle-orm';
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

/**
 * Increment 3 Task 5 (O3): builds whatever additional atomic statements are
 * needed to register `tenureId` as a Challenge pending joiner in
 * `sessionId`'s engine state — a no-op (`[]`) when there is no active
 * Challenge round to defer into (brief Step 2's "outside Challenge... may
 * participate immediately" — nothing Challenge-specific to do). Returning
 * statements (rather than performing the write itself) lets `attachAdventurer`
 * append them to its OWN `runCampaignAtomic` call, so tenure creation and
 * pending-join registration commit as one transaction — never a tenure that
 * exists in the campaign but was silently dropped from the session's roster
 * bookkeeping. See `$lib/server/session/command-service.ts`'s
 * `buildPendingChallengeJoinStatements` for the concrete implementation.
 */
export type BuildChallengeJoinStatements = (input: {
	db: AppDb;
	sessionId: string;
	tenureId: string;
}) => Promise<CampaignAtomicStatement[]>;

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
	sessionState: SessionStatePort = noSessionsYet,
	buildChallengeJoinStatements?: BuildChallengeJoinStatements
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
	// Built BEFORE the atomic write so a Challenge-join registration failure
	// (e.g. the session load itself throwing) surfaces before any statement
	// runs, rather than after tenure creation already committed. When there is
	// no active session, or the caller supplied no callback, this is `[]` —
	// exactly today's behavior (O3's first sentence: outside Challenge there is
	// nothing extra to do).
	const challengeJoinStatements =
		activeSessionId && buildChallengeJoinStatements
			? await buildChallengeJoinStatements({ db, sessionId: activeSessionId, tenureId })
			: [];
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
			...challengeJoinStatements,
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

// ---------------------------------------------------------------------------
// Death within an active Challenge round (Increment 3 Task 5, O4)
//
// `$lib/server/character/life.ts`'s `markCharacterDead` already owns
// out-of-session/no-active-procedure death. This is the SEPARATE, Challenge-
// aware path: marking a PARTICIPATING adventurer dead must, in one mutation,
// claim the character version, update life JSON/status, end the tenure,
// redact the tenure's owned Challenge zones, update participant state, emit
// public death/cleanup events, and free membership eligibility (tenure
// ending already frees it — `readActiveMembershipTenure` reads `ended_at IS
// NULL`). The character/tenure half lives here (mirroring
// `characterEligibilityClaim`'s conditional-claim style exactly — Increment
// 1's established pattern, not a new one); the session-engine half
// (`markTenureDead`, zone/participant bookkeeping) plus the final combined
// atomic write live in `$lib/server/session/command-service.ts`, which
// composes both into ONE `runCampaignAtomic` call.
// ---------------------------------------------------------------------------

export interface ChallengeDeathContext {
	characterId: string;
	membershipId: string;
	campaignId: string;
	characterUserId: string;
	characterVersion: number;
	characterDataJson: string;
	campaignOwnerUserId: string;
}

/** Reads everything needed to authorize and build the death statements for
 * `tenureId`'s CURRENT (not-yet-ended) tenure — or `null` if there is no such
 * tenure, or its character is already dead (the same "not-found"-shaped
 * failure `markCharacterDead` uses for an ineligible target, so a caller
 * doesn't need a separate "already dead" branch here). */
export async function readChallengeDeathContext(
	db: AppDb,
	tenureId: string
): Promise<ChallengeDeathContext | null> {
	const row = await db
		.select({
			characterId: campaignAdventurerTenures.characterId,
			membershipId: campaignAdventurerTenures.membershipId,
			campaignId: campaignAdventurerTenures.campaignId,
			characterUserId: characters.userId,
			characterVersion: characters.version,
			characterDataJson: characters.data,
			lifeStatus: characters.lifeStatus,
			campaignOwnerUserId: campaigns.ownerUserId
		})
		.from(campaignAdventurerTenures)
		.innerJoin(characters, eq(characters.id, campaignAdventurerTenures.characterId))
		.innerJoin(campaigns, eq(campaigns.id, campaignAdventurerTenures.campaignId))
		.where(and(eq(campaignAdventurerTenures.id, tenureId), isNull(campaignAdventurerTenures.endedAt)))
		.get();
	if (!row || row.lifeStatus !== 'alive') return null;
	return row;
}

/**
 * The conditional claim proving, at commit time, that `tenureId`'s character
 * is still alive at `expectedCharacterVersion` AND `tenureId` is still the
 * active tenure for `characterId` — mirrors `characterEligibilityClaim`'s
 * INSERT...SELECT...WHERE shape exactly (Increment 1's established pattern),
 * plus a caller-supplied `sessionGuard` so the SAME claim also proves the
 * session is still at the version the caller read Challenge state from
 * (composability point, same idiom `characterEligibilityClaim`'s own
 * `sessionGuard` parameter already established). A zero-row claim here makes
 * the LAST statement in `challengeDeathStatements` — the FK-dependent receipt
 * — fail, aborting the whole batch (`mutationClaimReceipt`'s doc comment:
 * "Append this last so a zero-row conditional claim becomes an FK failure").
 */
export function challengeDeathClaimStatement(
	db: AppDb,
	input: {
		claimId: string;
		campaignId: string;
		characterId: string;
		tenureId: string;
		actorUserId: string;
		expectedCharacterVersion: number;
		now: Date;
		sessionGuard: SQL;
	}
): CampaignAtomicStatement {
	return db.insert(campaignMutationClaims).select(
		db
			.select({
				id: sql<string>`${input.claimId}`.as('id'),
				campaignId: sql<string>`${input.campaignId}`.as('campaign_id'),
				characterId: characters.id,
				kind: sql<string>`${'challenge.death'}`.as('kind'),
				actorUserId: sql<string>`${input.actorUserId}`.as('actor_user_id'),
				createdAt: sql<Date>`${Math.floor(input.now.getTime() / 1000)}`.as('created_at')
			})
			.from(characters)
			.where(
				and(
					eq(characters.id, input.characterId),
					eq(characters.version, input.expectedCharacterVersion),
					eq(characters.lifeStatus, 'alive'),
					exists(
						db
							.select({ id: campaignAdventurerTenures.id })
							.from(campaignAdventurerTenures)
							.where(
								and(
									eq(campaignAdventurerTenures.id, input.tenureId),
									eq(campaignAdventurerTenures.characterId, input.characterId),
									eq(campaignAdventurerTenures.campaignId, input.campaignId),
									isNull(campaignAdventurerTenures.endedAt)
								)
							)
					),
					input.sessionGuard
				)
			)
	);
}

/** The character/tenure half of a Challenge death: claim, version-claim
 * record, the character's `data`/`life_status`/`version` update, the
 * tenure's `ended_at`/`end_reason`/`death_session_id` update, and the FK-
 * dependent receipt. Ordered exactly like `markCharacterDead`'s own statement
 * list (claim, version claim, character update, tenure update, receipt) —
 * the caller (`command-service.ts`) appends the session-engine statements and
 * the public `adventurer.died`/redaction events around these before running
 * everything in ONE `runCampaignAtomic` call. */
export function challengeDeathStatements(
	db: AppDb,
	input: {
		claimId: string;
		campaignId: string;
		characterId: string;
		tenureId: string;
		actorUserId: string;
		sessionId: string;
		characterDataJson: string;
		expectedCharacterVersion: number;
		now: Date;
		sessionGuard: SQL;
	}
): CampaignAtomicStatement[] {
	const resultingVersion = input.expectedCharacterVersion + 1;
	return [
		challengeDeathClaimStatement(db, {
			claimId: input.claimId,
			campaignId: input.campaignId,
			characterId: input.characterId,
			tenureId: input.tenureId,
			actorUserId: input.actorUserId,
			expectedCharacterVersion: input.expectedCharacterVersion,
			now: input.now,
			sessionGuard: input.sessionGuard
		}),
		db.insert(characterVersionClaims).values({
			characterId: input.characterId,
			resultingVersion,
			mutationKind: 'death',
			actorUserId: input.actorUserId,
			createdAt: input.now
		}),
		db
			.update(characters)
			.set({
				data: input.characterDataJson,
				lifeStatus: 'dead',
				version: resultingVersion,
				updatedAt: input.now
			})
			.where(and(eq(characters.id, input.characterId), eq(characters.version, input.expectedCharacterVersion))),
		db
			.update(campaignAdventurerTenures)
			.set({
				endedAt: input.now,
				endedByUserId: input.actorUserId,
				endReason: 'died',
				deathSessionId: input.sessionId
			})
			.where(and(eq(campaignAdventurerTenures.id, input.tenureId), isNull(campaignAdventurerTenures.endedAt))),
		mutationClaimReceipt(db, input.claimId)
	];
}
