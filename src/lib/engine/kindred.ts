/**
 * Kith & Kin resolution. A kith sets the three arête triggers; a kin grants a
 * mastered talent (and, once all three triggers are met, an arête talent). Pure.
 */

import type { KithDefinition, KinDefinition } from '$lib/types/content-pack';

export interface ResolvedKin {
	kith: KithDefinition;
	kin: KinDefinition;
}

/** Look up the (kith, kin) pair, ensuring the kin belongs to the kith. */
export function resolveKin(
	kiths: KithDefinition[],
	kithId: string | null,
	kinId: string | null
): ResolvedKin | null {
	if (!kithId || !kinId) return null;
	const kith = kiths.find((k) => k.id === kithId);
	if (!kith) return null;
	const kin = kith.kins.find((k) => k.id === kinId);
	if (!kin) return null;
	return { kith, kin };
}

export interface KinGrants {
	masteredTalentId: string;
	areteTalentId: string | null;
	areteTriggers: string[];
}

/** The talents and arête triggers an adventurer gets from their kith and kin. */
export function kinGrants(resolved: ResolvedKin): KinGrants {
	return {
		masteredTalentId: resolved.kin.masteredTalentId,
		areteTalentId: resolved.kin.areteTalentId ?? null,
		areteTriggers: resolved.kith.areteTriggers
	};
}
