import { and, asc, eq, isNull } from 'drizzle-orm';
import type { AppDb } from '$lib/server/db';
import {
	campaignAdventurerTenures,
	campaignMembers,
	characters,
	users
} from '$lib/server/db/schema';
import { readAdventurerEligibility } from './tenure';

export interface CampaignMemberView {
	id: string;
	displayName: string;
	joinedAt: Date;
	leftAt: Date | null;
	removedAt: Date | null;
}

export interface CampaignTenureView {
	id: string;
	membershipId: string;
	characterId: string;
	characterName: string;
	startedAt: Date;
	endedAt: Date | null;
	endReason: string | null;
}

export interface EligibleAdventurerView {
	id: string;
	name: string;
}

export async function loadCampaignRosterView(db: AppDb, campaignId: string) {
	const [members, tenures] = await Promise.all([
		db
			.select({
				id: campaignMembers.id,
				displayName: users.name,
				joinedAt: campaignMembers.joinedAt,
				leftAt: campaignMembers.leftAt,
				removedAt: campaignMembers.removedAt
			})
			.from(campaignMembers)
			.innerJoin(users, eq(users.id, campaignMembers.userId))
			.where(eq(campaignMembers.campaignId, campaignId))
			.orderBy(asc(campaignMembers.joinedAt)),
		db
			.select({
				id: campaignAdventurerTenures.id,
				membershipId: campaignAdventurerTenures.membershipId,
				characterId: campaignAdventurerTenures.characterId,
				characterName: characters.name,
				startedAt: campaignAdventurerTenures.startedAt,
				endedAt: campaignAdventurerTenures.endedAt,
				endReason: campaignAdventurerTenures.endReason
			})
			.from(campaignAdventurerTenures)
			.innerJoin(characters, eq(characters.id, campaignAdventurerTenures.characterId))
			.where(eq(campaignAdventurerTenures.campaignId, campaignId))
			.orderBy(asc(campaignAdventurerTenures.startedAt))
	]);

	return {
		members: members.map((member) => ({
			...member,
			displayName: member.displayName?.trim() || 'Guild member'
		})) satisfies CampaignMemberView[],
		tenures: tenures.map((tenure) => ({
			...tenure,
			characterName: tenure.characterName.trim() || 'Unnamed adventurer'
		})) satisfies CampaignTenureView[]
	};
}

export async function listEligibleAdventurersForUser(
	db: AppDb,
	userId: string
): Promise<EligibleAdventurerView[]> {
	const owned = await db
		.select({ id: characters.id, name: characters.name })
		.from(characters)
		.where(eq(characters.userId, userId))
		.orderBy(asc(characters.name));
	const eligible: EligibleAdventurerView[] = [];
	for (const character of owned) {
		const result = await readAdventurerEligibility(db, character.id, userId);
		if (result.ok) {
			eligible.push({
				id: character.id,
				name: character.name.trim() || 'Unnamed adventurer'
			});
		}
	}
	return eligible;
}

export interface ActiveChallengeTenureView {
	tenureId: string;
	userId: string;
	characterName: string;
}

/**
 * Every CURRENTLY-active adventurer tenure in `campaignId` (Increment 3 Task
 * 6) — exactly the `{participantTenureIds, tenureOwners}` roster the GM's
 * "Begin Challenge" control needs to submit, since neither the generic nor
 * Challenge projection carries campaign roster/tenure data (that's
 * campaign-domain, not session-engine state). Never fabricates a display
 * name beyond the same "Unnamed adventurer" fallback `loadCampaignRosterView`
 * already uses.
 */
export async function loadActiveChallengeRoster(db: AppDb, campaignId: string): Promise<ActiveChallengeTenureView[]> {
	const rows = await db
		.select({
			tenureId: campaignAdventurerTenures.id,
			userId: campaignMembers.userId,
			characterName: characters.name
		})
		.from(campaignAdventurerTenures)
		.innerJoin(campaignMembers, eq(campaignMembers.id, campaignAdventurerTenures.membershipId))
		.innerJoin(characters, eq(characters.id, campaignAdventurerTenures.characterId))
		.where(and(eq(campaignAdventurerTenures.campaignId, campaignId), isNull(campaignAdventurerTenures.endedAt)))
		.orderBy(asc(campaignAdventurerTenures.startedAt));

	return rows.map((row) => ({ ...row, characterName: row.characterName.trim() || 'Unnamed adventurer' }));
}
