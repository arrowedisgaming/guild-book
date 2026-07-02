/**
 * Path (calling) resolution and starting-talent assembly. A path is bound to a
 * suit (which becomes the adventurer's 4-attribute) and grants a set of talents;
 * one path talent is mastered at creation and the rest are "in training". The
 * kin talent begins mastered. Pure.
 */

import type { PathDefinition, KinDefinition } from '$lib/types/content-pack';
import type { TalentAllocation } from '$lib/types/character';

export function resolvePath(paths: PathDefinition[], pathId: string | null): PathDefinition | null {
	if (!pathId) return null;
	return paths.find((p) => p.id === pathId) ?? null;
}

/**
 * Assemble the adventurer's starting talents: the kin talent (mastered), plus
 * the path's talents with `masteredPathTalentId` mastered and the rest in
 * training. `at` is the ISO timestamp recorded on each allocation.
 */
export function buildStartingTalents(params: {
	kin: KinDefinition;
	path: PathDefinition;
	masteredPathTalentId: string | null;
	at: string;
}): TalentAllocation[] {
	const { kin, path, masteredPathTalentId, at } = params;

	const kinTalent: TalentAllocation = {
		talentId: kin.masteredTalentId,
		state: 'mastered',
		source: 'kin',
		sourceLabel: kin.name,
		at,
		wounded: false,
		xp: 0
	};

	const pathTalents: TalentAllocation[] = path.talentIds.map((talentId) => ({
		talentId,
		state: talentId === masteredPathTalentId ? 'mastered' : ('in-training' as const),
		source: 'path' as const,
		sourceLabel: path.name,
		at,
		wounded: false,
		xp: 0
	}));

	return [kinTalent, ...pathTalents];
}
