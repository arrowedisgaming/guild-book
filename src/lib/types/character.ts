import type { SuitId, ItemTier, TalentState } from './common';
import { SUIT_IDS } from './common';

/** Schema version for character-data migration (migrate-on-read). */
export const CHARACTER_SCHEMA_VERSION = 1;

/**
 * Provenance for an allocation (attribute value, talent grant, …). Mirrors the
 * Miskatonic University Registrar audit-trail pattern: every point records
 * where it came from so the sheet can explain itself and edits stay honest.
 */
export interface AllocationSource {
	source: 'kith' | 'kin' | 'path' | 'personal' | 'advancement';
	sourceLabel: string;
	/** ISO 8601 timestamp. */
	at: string;
}

/** One of the four attributes with its value and provenance. */
export interface AttributeState {
	value: number;
	sources: AllocationSource[];
}

/** A talent the adventurer holds, with its mastery state and origin. */
export interface TalentAllocation {
	talentId: string;
	state: TalentState;
	source: 'kin' | 'path' | 'arete' | 'general';
	sourceLabel: string;
	at: string;
}

/** A bond with a named guild-mate. */
export interface Bond {
	targetName: string;
	text: string;
}

/** An owned item; either a content item (by id) or a free-typed one. */
export interface EquipmentEntry {
	itemId: string | null;
	customName: string | null;
	tier: ItemTier;
	packSpace: number;
}

/** Arête progress — the three kith triggers, and whether the talent is earned. */
export interface AreteState {
	triggersMet: [boolean, boolean, boolean];
	talentEarned: boolean;
}

/**
 * The full His Majesty the Worm adventurer, stored as a JSON blob. Denormalised
 * columns (name, kith, path) live alongside this in the database for cheap
 * listing; this blob is the source of truth.
 */
export interface GuildBookCharacterData {
	schemaVersion: number;
	system: 'hmtw';
	contentPackId: string;

	// Identity
	name: string;
	pronouns: string;
	appearance: string;
	portraitUrl: string;

	// Kith & Kin, Path
	kithId: string | null;
	kinId: string | null;
	pathId: string | null;

	// Attributes — the four suits, spread {4,3,2,1}, highest fixed to path suit
	attributes: Record<SuitId, AttributeState>;

	// Talents (kin talent mastered; path grants seven, one mastered)
	talents: TalentAllocation[];

	// Narrative
	quest: string;
	motifs: string[];
	bonds: Bond[];

	// Resources & state
	resolve: { current: number; max: number };
	arete: AreteState;
	languages: string[];
	conditions: string[];
	lore: number;
	experience: number;

	// Gear (Omphalic Market)
	equipment: EquipmentEntry[];

	notes: string;

	// Wizard/meta
	isDraft: boolean;
	wizardStep: number;
}

/** A fresh, empty adventurer with a zeroed but structurally-valid shape. */
export function createBlankCharacter(contentPackId = 'hmtw'): GuildBookCharacterData {
	const attributes = Object.fromEntries(
		SUIT_IDS.map((suit) => [suit, { value: 0, sources: [] as AllocationSource[] }])
	) as Record<SuitId, AttributeState>;

	return {
		schemaVersion: CHARACTER_SCHEMA_VERSION,
		system: 'hmtw',
		contentPackId,
		name: '',
		pronouns: '',
		appearance: '',
		portraitUrl: '',
		kithId: null,
		kinId: null,
		pathId: null,
		attributes,
		talents: [],
		quest: '',
		motifs: [],
		bonds: [],
		resolve: { current: 4, max: 4 },
		arete: { triggersMet: [false, false, false], talentEarned: false },
		languages: [],
		conditions: [],
		lore: 0,
		experience: 0,
		equipment: [],
		notes: '',
		isDraft: true,
		wizardStep: 0
	};
}
