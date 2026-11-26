/**
 * The order talents are listed on a sheet: mastered first (the kin talent
 * leading), then those with XP invested, then the untrained — each group by
 * name. Pure.
 */

import type { TalentAllocation } from '$lib/types/character';

type Sortable = Pick<TalentAllocation, 'talentId' | 'state' | 'source' | 'xp'>;

function rank(talent: Sortable): number {
	if (talent.state === 'mastered') return talent.source === 'kin' ? 0 : 1;
	return talent.xp > 0 ? 2 : 3;
}

/** Returns a new array in sheet order; `nameOf` resolves a talent id to its display name. */
export function sortTalents<T extends Sortable>(talents: readonly T[], nameOf: (talentId: string) => string): T[] {
	return talents
		.map((talent) => ({ talent, rank: rank(talent), name: nameOf(talent.talentId) }))
		.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }))
		.map((entry) => entry.talent);
}
