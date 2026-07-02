/**
 * Resolve a stored adventurer into a display-ready view: content-pack ids
 * (kith/kin/path/talent/item) become human names, attributes are ordered,
 * encumbrance is summarised. Server-side (uses the content loader). Shared by
 * the owner sheet and the public share page so both render identically.
 */

import type { GuildBookCharacterData } from '$lib/types/character';
import type { CharacterView } from '$lib/types/character-view';
import { SUIT_IDS } from '$lib/types/common';
import { indexItems, loadSummary, slotsFor } from '$lib/engine/encumbrance';
import {
	getContentPack,
	getKiths,
	getPaths,
	getTalents,
	getItems,
	getConditions,
	getAfflictions
} from '$lib/server/content/loader';

export type { CharacterView };

export function buildCharacterView(char: GuildBookCharacterData): CharacterView {
	const pack = getContentPack();
	const kith = getKiths().find((k) => k.id === char.kithId) ?? null;
	const kin = kith?.kins.find((k) => k.id === char.kinId) ?? null;
	const path = getPaths().find((p) => p.id === char.pathId) ?? null;
	const talentsById = new Map(getTalents().map((t) => [t.id, t]));
	const items = indexItems(getItems());
	const conditionsById = new Map(getConditions().map((c) => [c.id, c]));
	const afflictionsById = new Map(getAfflictions().map((a) => [a.id, a]));
	const attrNames = new Map(pack.attributes.map((a) => [a.id, a.name]));

	const load = loadSummary(char.equipment, items, pack.encumbrance);

	return {
		name: char.name || 'Unnamed Adventurer',
		pronouns: char.pronouns,
		appearance: char.appearance,
		quest: char.quest,
		notes: char.notes,
		kith: kith?.name ?? null,
		kin: kin?.name ?? null,
		path: path?.name ?? null,
		attributes: SUIT_IDS.map((id) => ({
			id,
			name: attrNames.get(id) ?? id,
			value: char.attributes[id]?.value ?? 0
		})),
		talents: char.talents.map((t) => ({
			name: talentsById.get(t.talentId)?.name ?? t.talentId,
			state: t.state,
			wounded: t.wounded,
			xp: t.xp
		})),
		motifs: char.motifs,
		bonds: char.bonds,
		equipment: char.equipment.map((e) => {
			const def = e.itemId ? items.get(e.itemId) : undefined;
			const durability = def?.notches ?? null;
			return {
				name: e.customName ?? def?.name ?? 'Item',
				tier: e.tier,
				location: e.location,
				quantity: e.quantity,
				slots: slotsFor(e, def),
				notchesTaken: e.notchesTaken,
				durability,
				destroyed: durability !== null && e.notchesTaken >= durability
			};
		}),
		load: { hands: load.hands, belt: load.belt, pack: load.pack },
		conditions: char.conditions.map((id) => {
			const def = conditionsById.get(id);
			return { id, name: def?.name ?? id, description: def?.description ?? '' };
		}),
		afflictions: char.afflictions.map((a) => {
			const def = a.afflictionId ? afflictionsById.get(a.afflictionId) : undefined;
			const stage = def?.stages.find((s) => s.stage === a.stage);
			return {
				name: a.customName ?? def?.name ?? 'Affliction',
				stage: a.stage,
				stageCount: def?.stages.length ?? a.stage,
				effect: stage?.effect ?? ''
			};
		}),
		resolve: char.resolve,
		lore: char.lore,
		languages: char.languages
	};
}
