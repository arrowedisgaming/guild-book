/**
 * Resolve an adventurer into a display-ready view using already-loaded content.
 * This stays browser-safe so anonymous wizard drafts can be exported without a
 * round trip through an authenticated API.
 */

import { indexItems, loadSummary, slotsFor } from '$lib/engine/encumbrance';
import type { GuildBookCharacterData } from '$lib/types/character';
import type { CharacterView } from '$lib/types/character-view';
import type {
	AfflictionDefinition,
	GuildBookContentPack,
	ItemDefinition,
	KithDefinition,
	NamedEntry,
	PathDefinition,
	TalentDefinition
} from '$lib/types/content-pack';
import { SUIT_IDS } from '$lib/types/common';

export interface CharacterViewContent {
	contentPack: GuildBookContentPack;
	kiths: KithDefinition[];
	paths: PathDefinition[];
	talents: TalentDefinition[];
	items: ItemDefinition[];
	conditions: NamedEntry[];
	afflictions: AfflictionDefinition[];
}

export function buildCharacterViewFromContent(
	char: GuildBookCharacterData,
	content: CharacterViewContent
): CharacterView {
	const kith = content.kiths.find((entry) => entry.id === char.kithId) ?? null;
	const kin = kith?.kins.find((entry) => entry.id === char.kinId) ?? null;
	const path = content.paths.find((entry) => entry.id === char.pathId) ?? null;
	const talentsById = new Map(content.talents.map((talent) => [talent.id, talent]));
	const items = indexItems(content.items);
	const conditionsById = new Map(content.conditions.map((condition) => [condition.id, condition]));
	const afflictionsById = new Map(
		content.afflictions.map((affliction) => [affliction.id, affliction])
	);
	const attrNames = new Map(
		content.contentPack.attributes.map((attribute) => [attribute.id, attribute.name])
	);
	const load = loadSummary(char.equipment, items, content.contentPack.encumbrance);

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
		talents: char.talents.map((talent) => ({
			name: talentsById.get(talent.talentId)?.name ?? talent.talentId,
			state: talent.state,
			wounded: talent.wounded,
			xp: talent.xp
		})),
		motifs: char.motifs,
		bonds: char.bonds,
		equipment: char.equipment.map((equipment) => {
			const definition = equipment.itemId ? items.get(equipment.itemId) : undefined;
			const durability = definition?.notches ?? null;
			return {
				name: equipment.customName ?? definition?.name ?? 'Item',
				tier: equipment.tier,
				location: equipment.location,
				quantity: equipment.quantity,
				slots: slotsFor(equipment, definition),
				notchesTaken: equipment.notchesTaken,
				durability,
				destroyed: durability !== null && equipment.notchesTaken >= durability
			};
		}),
		load: { hands: load.hands, belt: load.belt, pack: load.pack },
		conditions: char.conditions.map((id) => {
			const definition = conditionsById.get(id);
			return { id, name: definition?.name ?? id, description: definition?.description ?? '' };
		}),
		afflictions: char.afflictions.map((affliction) => {
			const definition = affliction.afflictionId
				? afflictionsById.get(affliction.afflictionId)
				: undefined;
			const stage = definition?.stages.find((entry) => entry.stage === affliction.stage);
			return {
				name: affliction.customName ?? definition?.name ?? 'Affliction',
				stage: affliction.stage,
				stageCount: definition?.stages.length ?? affliction.stage,
				effect: stage?.effect ?? ''
			};
		}),
		resolve: char.resolve,
		lore: char.lore,
		languages: char.languages
	};
}
