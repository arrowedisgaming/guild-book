/**
 * Server-read facts a guided test of fate needs (Increment 4 Task 2).
 *
 * The pure engine deliberately cannot reach a character sheet, and the command
 * schema deliberately cannot carry one — so this is the single place a tested
 * attribute's value and an adventurer's current Resolve enter the session write
 * path. Both are read fresh from the stored document on every command; nothing
 * here trusts a client claim, and nothing here is cached across commands (a
 * player editing their sheet on another screen must be visible to the next
 * test).
 *
 * `rosterOrder` is the tenure's `startedAt` position — the same ordering
 * `loadActiveChallengeRoster` already uses — because Ch1 makes roster order the
 * stable tie-break when a group test's most- or least-qualified end is tied.
 */

import { and, asc, eq, isNull } from 'drizzle-orm';
import type { AppDb } from '$lib/server/db';
import { campaignAdventurerTenures, campaignMembers, characters } from '$lib/server/db/schema';
import { migrateCharacterData } from '$lib/engine/character-migration';
import { SUIT_IDS, type SuitId } from '$lib/types/common';
import type { GuildBookCharacterData } from '$lib/types/character';
import type { GuidedTestActorFacts, GuidedTestMaterials } from '$lib/engine/session/procedures/test-of-fate';
import type { CampMaterials } from '$lib/engine/session/procedures/camp';

/**
 * Every living, attached adventurer in `campaignId`, with all four attribute
 * values and current Resolve. All four attributes travel together because the
 * tested suit is chosen at declare time — see `GuidedTestActorFacts`.
 *
 * A dead adventurer is excluded: they cannot be called on to test, and
 * `readResolveWriteContext` would refuse their spend anyway.
 */
export async function loadSessionActorFacts(db: AppDb, campaignId: string): Promise<GuidedTestMaterials> {
	const rows = await db
		.select({
			tenureId: campaignAdventurerTenures.id,
			characterId: characters.id,
			userId: campaignMembers.userId,
			data: characters.data,
			version: characters.version
		})
		.from(campaignAdventurerTenures)
		.innerJoin(campaignMembers, eq(campaignMembers.id, campaignAdventurerTenures.membershipId))
		.innerJoin(characters, eq(characters.id, campaignAdventurerTenures.characterId))
		.where(
			and(
				eq(campaignAdventurerTenures.campaignId, campaignId),
				isNull(campaignAdventurerTenures.endedAt),
				eq(characters.lifeStatus, 'alive')
			)
		)
		.orderBy(asc(campaignAdventurerTenures.startedAt));

	const actors: GuidedTestActorFacts[] = rows.map((row, index) => {
		const data = parseCharacterData(row.data);
		return {
			tenureId: row.tenureId,
			characterId: row.characterId,
			userId: row.userId,
			attributes: attributeValues(data),
			resolveCurrent: data.resolve.current,
			// Read in the SAME query as `resolveCurrent`, so the pair the tester
			// reconfirms with can never describe two different moments.
			characterVersion: row.version,
			rosterOrder: index
		};
	});

	return { actors };
}

/**
 * The guided test's view of those facts. An alias, not a second query: a test of
 * fate needs the tested attribute plus Resolve and the character version, which
 * is the full row this loader already reads.
 */
export const loadGuidedTestMaterials = loadSessionActorFacts;

/**
 * Camp's view of the same facts (Increment 4 Task 3). `CampActorFacts` is a
 * strict subset of `GuidedTestActorFacts` — attributes and roster order, no
 * Resolve or character version, because no Camp procedure spends a resource —
 * so this is one query serving both surfaces rather than two reads of the same
 * rows. Typed as `CampMaterials` so a Camp caller never sees fields it has no
 * business reading.
 */
export async function loadCampMaterials(db: AppDb, campaignId: string): Promise<CampMaterials> {
	return loadSessionActorFacts(db, campaignId);
}

/** Flattens `Record<SuitId, AttributeState>` to the plain numbers the engine
 * tests against. The allocation provenance every `AttributeState` carries is
 * sheet bookkeeping and has no business crossing into a session projection. */
function attributeValues(data: GuildBookCharacterData): Record<SuitId, number> {
	const values = {} as Record<SuitId, number>;
	for (const suit of SUIT_IDS) {
		values[suit] = data.attributes[suit]?.value ?? 0;
	}
	return values;
}

/** Migrate-on-read, matching `resource-write.ts`'s own parse: a document
 * written under an older `schemaVersion` must still yield current attribute and
 * Resolve values rather than failing the whole table's test. */
function parseCharacterData(json: string): GuildBookCharacterData {
	try {
		return migrateCharacterData(JSON.parse(json));
	} catch {
		return migrateCharacterData(null);
	}
}
