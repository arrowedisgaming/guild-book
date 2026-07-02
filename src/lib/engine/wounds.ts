/**
 * Wound handling. Taking a Wound is a choice between notching protective gear,
 * wounding a trained talent (at most two may be wounded at once), or marking a
 * condition — Staggered, Injured, or Death's Door. While Injured, the rules say
 * the next wound must be Death's Door; per the app's "enforce caps, guide the
 * rest" policy we surface that as guidance rather than a hard block, but the
 * two-wounded-talents cap IS hard. Pure.
 */

import type { GuildBookCharacterData, EquipmentEntry } from '$lib/types/character';
import type { ItemIndex } from './encumbrance';

export const MAX_WOUNDED_TALENTS = 2;

/** Condition ids, matching the content pack's conditions.json. */
export const CONDITION_IDS = {
	stressed: 'stressed',
	staggered: 'staggered',
	injured: 'injured',
	deathsDoor: 'deaths-door'
} as const;

export function hasCondition(char: GuildBookCharacterData, conditionId: string): boolean {
	return char.conditions.includes(conditionId);
}

export function woundedTalentCount(char: GuildBookCharacterData): number {
	return char.talents.filter((t) => t.wounded).length;
}

export function canWoundTalent(char: GuildBookCharacterData): boolean {
	return woundedTalentCount(char) < MAX_WOUNDED_TALENTS;
}

export type WoundOption =
	| { type: 'notch'; entryIndex: number; label: string; detail: string }
	| { type: 'wound-talent'; talentId: string; label: string; detail: string }
	| { type: 'condition'; conditionId: string; label: string; detail: string };

export interface WoundChoices {
	options: WoundOption[];
	/** Rule guidance to show alongside the options. */
	hints: string[];
}

/** True when this gear can soak a wound: protective, positioned, and intact. */
function isNotchable(entry: EquipmentEntry, items: ItemIndex): boolean {
	if (!entry.itemId) return false;
	const def = items.get(entry.itemId);
	if (!def) return false;
	const protective = def.category === 'armor' || def.category === 'shield';
	if (!protective) return false;
	// Armor must be worn; shields must be in hand to absorb a blow.
	const positioned =
		def.category === 'shield' ? entry.location === 'hand' : entry.location === 'worn';
	const durability = def.notches ?? 0;
	return positioned && durability > 0 && entry.notchesTaken < durability;
}

/**
 * The legal ways to absorb a Wound right now. Talent options vanish at the
 * two-wounded cap (hard rule); the Injured→Death's Door rule arrives as a hint.
 */
export function woundOptions(char: GuildBookCharacterData, items: ItemIndex): WoundChoices {
	const options: WoundOption[] = [];
	const hints: string[] = [];
	const injured = hasCondition(char, CONDITION_IDS.injured);

	char.equipment.forEach((entry, entryIndex) => {
		if (!isNotchable(entry, items)) return;
		const def = items.get(entry.itemId!)!;
		const left = (def.notches ?? 0) - entry.notchesTaken;
		options.push({
			type: 'notch',
			entryIndex,
			label: `Notch ${def.name}`,
			detail: `${left} notch${left === 1 ? '' : 'es'} remaining before it's Destroyed`
		});
	});

	if (canWoundTalent(char)) {
		for (const t of char.talents) {
			if (t.wounded) continue;
			options.push({
				type: 'wound-talent',
				talentId: t.talentId,
				label: `Wound a talent`,
				detail: t.talentId
			});
		}
	} else {
		hints.push('Two talents are already wounded — the cap. Choose another way to take this wound.');
	}

	if (!hasCondition(char, CONDITION_IDS.staggered)) {
		options.push({
			type: 'condition',
			conditionId: CONDITION_IDS.staggered,
			label: 'Mark Staggered',
			detail: 'No immediate effect; clears at camp (unless Stressed).'
		});
	}
	if (!injured) {
		options.push({
			type: 'condition',
			conditionId: CONDITION_IDS.injured,
			label: 'Mark Injured',
			detail: "Dangerous: while Injured, your next wound must be Death's Door."
		});
	}
	if (!hasCondition(char, CONDITION_IDS.deathsDoor)) {
		options.push({
			type: 'condition',
			conditionId: CONDITION_IDS.deathsDoor,
			label: "Mark Death's Door",
			detail: 'Unconscious and helpless — one watch to be healed, or die.'
		});
	}

	if (injured) {
		hints.push("You are Injured — by the rules this wound must be Death's Door.");
	}

	return { options, hints };
}

/** Apply a chosen wound option, returning a new character. */
export function applyWound(
	char: GuildBookCharacterData,
	option: WoundOption
): GuildBookCharacterData {
	switch (option.type) {
		case 'notch':
			return {
				...char,
				equipment: char.equipment.map((e, i) =>
					i === option.entryIndex ? { ...e, notchesTaken: e.notchesTaken + 1 } : e
				)
			};
		case 'wound-talent': {
			if (!canWoundTalent(char)) return char; // hard cap
			let done = false;
			return {
				...char,
				talents: char.talents.map((t) => {
					if (done || t.talentId !== option.talentId || t.wounded) return t;
					done = true;
					return { ...t, wounded: true };
				})
			};
		}
		case 'condition':
			return hasCondition(char, option.conditionId)
				? char
				: { ...char, conditions: [...char.conditions, option.conditionId] };
	}
}

/** Heal one wounded talent (camp recovery: one burned bond charge each). */
export function healWoundedTalent(
	char: GuildBookCharacterData,
	talentId: string
): GuildBookCharacterData {
	let done = false;
	return {
		...char,
		talents: char.talents.map((t) => {
			if (done || t.talentId !== talentId || !t.wounded) return t;
			done = true;
			return { ...t, wounded: false };
		})
	};
}
