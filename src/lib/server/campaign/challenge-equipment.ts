/**
 * Resolves the two equipment booleans the Challenge engine cannot verify
 * itself (`modifiers.ts`'s `hasBow`/`hasShield` — O2: "a projection input,
 * not something to fabricate"). Reads a tenure's REAL, persisted character
 * equipment rather than trusting a client-side attestation — the "no VTT"
 * boundary (O6) is about not modeling health/position/range, not about
 * inventing a fictional honor-system checkbox for something the character
 * sheet already tracks precisely.
 *
 * `weapon-bow` is a recognized content id (the one specific item Aim
 * requires — Ch9 "Bow"), the same "stable identifier, not a rule value"
 * pattern already established by `deal.ts`'s `ELITE_THREAT_ID`/
 * `LARGER_THAN_HUMAN_SIZE_ID`. A shield is any equipped item whose content
 * definition's `category` is `'shield'` — content-driven, not a second
 * hardcoded id list.
 */

import { and, eq, isNull } from 'drizzle-orm';
import type { AppDb } from '$lib/server/db';
import { campaignAdventurerTenures, characters } from '$lib/server/db/schema';
import { migrateCharacterData } from '$lib/engine/character-migration';
import { getItems } from '$lib/server/content/loader';

const BOW_ITEM_ID = 'weapon-bow';
const SHIELD_CATEGORY = 'shield';

export interface ChallengeEquipmentCaps {
	hasBow: boolean;
	hasShield: boolean;
}

/** No bow, no shield — the fail-closed default (O1/O2) for a tenure whose
 * equipment can't be resolved (e.g. the GM, who holds no tenure). */
export const NO_EQUIPMENT: ChallengeEquipmentCaps = { hasBow: false, hasShield: false };

function capsFromCharacterDataJson(characterDataJson: string): ChallengeEquipmentCaps {
	let migrated;
	try {
		migrated = migrateCharacterData(JSON.parse(characterDataJson));
	} catch {
		migrated = migrateCharacterData(null);
	}
	const itemsById = new Map(getItems().map((item) => [item.id, item]));
	const hasBow = migrated.equipment.some((entry) => entry.itemId === BOW_ITEM_ID);
	const hasShield = migrated.equipment.some((entry) => entry.itemId !== null && itemsById.get(entry.itemId)?.category === SHIELD_CATEGORY);
	return { hasBow, hasShield };
}

/** Reads `tenureId`'s CURRENT (not-yet-ended) tenure's character equipment
 * and resolves the two Challenge-relevant booleans. Returns `NO_EQUIPMENT`
 * (fail closed — never fabricated) when the tenure can't be found, rather
 * than throwing: an equipment lookup miss should never crash a projection
 * build, only silently withhold the two commands that need it. */
export async function resolveChallengeEquipmentCaps(db: AppDb, tenureId: string): Promise<ChallengeEquipmentCaps> {
	const row = await db
		.select({ characterDataJson: characters.data })
		.from(campaignAdventurerTenures)
		.innerJoin(characters, eq(characters.id, campaignAdventurerTenures.characterId))
		.where(and(eq(campaignAdventurerTenures.id, tenureId), isNull(campaignAdventurerTenures.endedAt)))
		.get();
	if (!row) return NO_EQUIPMENT;
	return capsFromCharacterDataJson(row.characterDataJson);
}
