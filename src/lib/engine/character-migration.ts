/**
 * Migrate-on-read for stored adventurer JSON. Preserves the player's choices and
 * only fills in fields/defaults required by the current app version. At schema
 * v1 this is essentially a defensive normaliser: it merges stored data over a
 * blank base so every field the app reads is guaranteed to exist, even for
 * partially-written drafts. Future schema bumps add version-stepped transforms
 * here before the final normalise.
 *
 * Pure — no UI or DB imports.
 */

import {
	CHARACTER_SCHEMA_VERSION,
	createBlankCharacter,
	type GuildBookCharacterData,
	type AttributeState
} from '$lib/types/character';
import { SUIT_IDS } from '$lib/types/common';

export function migrateCharacterData(raw: unknown): GuildBookCharacterData {
	const base = createBlankCharacter();
	if (!raw || typeof raw !== 'object') return base;

	const stored = raw as Partial<GuildBookCharacterData> & Record<string, unknown>;

	// Merge each suit's attribute state over the base so all four suits exist.
	const attributes = { ...base.attributes };
	if (stored.attributes && typeof stored.attributes === 'object') {
		for (const suit of SUIT_IDS) {
			const s = (stored.attributes as Record<string, AttributeState>)[suit];
			if (s && typeof s === 'object') {
				attributes[suit] = {
					value: typeof s.value === 'number' ? s.value : 0,
					sources: Array.isArray(s.sources) ? s.sources : []
				};
			}
		}
	}

	return {
		...base,
		...stored,
		system: 'hmtw',
		schemaVersion: CHARACTER_SCHEMA_VERSION,
		attributes,
		resolve: { ...base.resolve, ...(stored.resolve ?? {}) },
		arete: {
			triggersMet: normalizeTriggers(stored.arete?.triggersMet),
			talentEarned: stored.arete?.talentEarned ?? base.arete.talentEarned
		},
		talents: Array.isArray(stored.talents) ? stored.talents : base.talents,
		motifs: Array.isArray(stored.motifs) ? stored.motifs : base.motifs,
		bonds: Array.isArray(stored.bonds) ? stored.bonds : base.bonds,
		equipment: Array.isArray(stored.equipment) ? stored.equipment : base.equipment,
		languages: Array.isArray(stored.languages) ? stored.languages : base.languages,
		conditions: Array.isArray(stored.conditions) ? stored.conditions : base.conditions
	};
}

function normalizeTriggers(value: unknown): [boolean, boolean, boolean] {
	if (Array.isArray(value) && value.length === 3) {
		return [Boolean(value[0]), Boolean(value[1]), Boolean(value[2])];
	}
	return [false, false, false];
}
