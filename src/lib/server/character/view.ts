/**
 * Resolve a stored adventurer into a display-ready view: content-pack ids
 * (kith/kin/path/talent/item) become human names, attributes are ordered, etc.
 * Server-side (uses the content loader). Shared by the owner sheet and the
 * public share page so both render identically.
 */

import type { GuildBookCharacterData } from '$lib/types/character';
import { SUIT_IDS } from '$lib/types/common';
import {
	getContentPack,
	getKiths,
	getPaths,
	getTalents,
	getItems
} from '$lib/server/content/loader';

export interface CharacterView {
	name: string;
	pronouns: string;
	appearance: string;
	quest: string;
	notes: string;
	kith: string | null;
	kin: string | null;
	path: string | null;
	attributes: { id: string; name: string; value: number }[];
	talents: { name: string; state: string }[];
	motifs: string[];
	bonds: { targetName: string; text: string }[];
	equipment: { name: string; tier: string }[];
	resolve: { current: number; max: number };
	languages: string[];
	conditions: string[];
}

export function buildCharacterView(char: GuildBookCharacterData): CharacterView {
	const pack = getContentPack();
	const kith = getKiths().find((k) => k.id === char.kithId) ?? null;
	const kin = kith?.kins.find((k) => k.id === char.kinId) ?? null;
	const path = getPaths().find((p) => p.id === char.pathId) ?? null;
	const talentsById = new Map(getTalents().map((t) => [t.id, t]));
	const itemsById = new Map(getItems().map((i) => [i.id, i]));
	const attrNames = new Map(pack.attributes.map((a) => [a.id, a.name]));

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
			state: t.state
		})),
		motifs: char.motifs,
		bonds: char.bonds,
		equipment: char.equipment.map((e) => ({
			name: e.customName ?? itemsById.get(e.itemId ?? '')?.name ?? 'Item',
			tier: e.tier
		})),
		resolve: char.resolve,
		languages: char.languages,
		conditions: char.conditions
	};
}
