import type { SuitId, RankId, ItemTier, TalentSource } from './common';

/**
 * Guild Book content pack — the single source of His Majesty the Worm rules
 * data. The committed pack under `static/content-packs/hmtw/` is a
 * placeholder; real rulebook data is dropped into the same JSON shapes with no
 * code changes. Every content-authored entity is referenced by string id.
 */
export interface GuildBookContentPack {
	id: string;
	name: string;
	version: string;
	description: string;
	system: 'hmtw';
	/** Licence marker — "placeholder" until real (licensed) data replaces it. */
	license: string;
	authors: string[];
	files: ContentPackFiles;
	/** The four suit-attributes (Swords/Pentacles/Cups/Wands). */
	attributes: AttributeDefinition[];
	/** Deck + resolution configuration. */
	tarot: TarotConfig;
	/** Creation-time constraints (spread, market allowance, counts). */
	creation: CreationRules;
	/** Carrying-capacity model (slots per location). */
	encumbrance: EncumbranceConfig;
}

/** Slot capacities for the three carrying locations. */
export interface EncumbranceConfig {
	handSlots: number;
	beltSlots: number;
	packSlots: number;
}

/** Filenames (relative to the pack folder) for each content collection. */
export interface ContentPackFiles {
	kiths: string;
	paths: string;
	talents: string;
	items: string;
	motifs?: string;
	languages?: string;
	conditions?: string;
	afflictions?: string;
	rules?: string;
}

/** One of the four attributes; `suit` binds it to the matching tarot suit. */
export interface AttributeDefinition {
	id: SuitId;
	name: string;
	suit: SuitId;
	/** e.g. "the attribute of warriors" — flavour shown in the wizard. */
	description: string;
	/** Short archetype label (warrior / rogue / scholar / sorcerer). */
	archetype?: string;
	min: number;
	max: number;
}

// ---------------------------------------------------------------------------
// Kith & Kin (two-level ancestry)
// ---------------------------------------------------------------------------

/**
 * A kith is the broad "race" (Human, Fay, Underfolk, Orc). It sets the three
 * arête triggers and contains the kins the player chooses from.
 */
export interface KithDefinition {
	id: string;
	name: string;
	description: string;
	/** The three arête triggers; checking all three earns the arête talent. */
	areteTriggers: string[];
	kins: KinDefinition[];
}

/** A kin is a sub-group of a kith (Wood elf, Dwarf, Fireblooded, …). */
export interface KinDefinition {
	id: string;
	name: string;
	description: string;
	/** Talent id granted, already mastered, at creation. */
	masteredTalentId: string;
	/** Talent id learned once all three of the kith's arête triggers are met. */
	areteTalentId?: string;
	/** Sample names to inspire the player (never required). */
	sampleNames?: string[];
}

// ---------------------------------------------------------------------------
// Paths (callings) & Talents
// ---------------------------------------------------------------------------

/**
 * A path is the adventurer's calling, tied to a suit. Choosing a path locks the
 * highest attribute (4) to that suit and grants the path's seven talents.
 */
export interface PathDefinition {
	id: string;
	name: string;
	/** The suit this path is aligned to — becomes the adventurer's 4-attribute. */
	suit: SuitId;
	description: string;
	/** Talent ids granted by this path (canonically seven). */
	talentIds: string[];
}

/**
 * A talent — a special ability. Talents live in one collection and are
 * referenced by kins (kin/arête talents) and paths (path talents).
 */
export interface TalentDefinition {
	id: string;
	name: string;
	description: string;
	source: TalentSource;
	/** Items a talent needs; these count as impoverished items at creation. */
	requiredItemIds?: string[];
}

// ---------------------------------------------------------------------------
// Equipment (the Omphalic Market)
// ---------------------------------------------------------------------------

export interface ItemDefinition {
	id: string;
	name: string;
	tier: ItemTier;
	category: string;
	description: string;
	/** Slots one unit (or one stack) consumes. Defaults to 1 when omitted. */
	slots?: number;
	/**
	 * Carrying restriction: 'belt-only' for oversized gear (pole, shovel, tent),
	 * 'hand' for things wielded (weapons/shields default here when held).
	 * Omitted = any location.
	 */
	carry?: 'any' | 'belt-only' | 'hand';
	/** Belt slots consumed when WORN (armor: light 1 / iron 2 / steel 3). */
	wornBeltSlots?: number;
	/** Durability — notches absorbed before Destroyed (fragile 1 / normal 2 / tempered 3). */
	notches?: number;
	/** Stackable items: how many units share one slot (arrows 12, lockpicks 6…). */
	stack?: { per: number; unit?: string };
	/** Mechanical properties (weapon rules etc.), shown as chips. */
	properties?: string[];
	/** Present for weapons/armour; free-form to stay data-driven. */
	stats?: Record<string, string | number>;
}

// ---------------------------------------------------------------------------
// Motifs, languages, conditions (light content collections)
// ---------------------------------------------------------------------------

/** Word banks for building the "descriptor + profession" motif phrases. */
export interface MotifTables {
	descriptors: string[];
	professions: string[];
}

export interface NamedEntry {
	id: string;
	name: string;
	description?: string;
}

/** A staged affliction (venoms, drugs, contagions). Stage 1 is mildest. */
export interface AfflictionDefinition {
	id: string;
	name: string;
	description?: string;
	stages: AfflictionStage[];
}

export interface AfflictionStage {
	stage: number;
	effect: string;
	/** Burned charges needed to cure this stage (null = incurable). */
	cureCost: number | null;
}

/** A rules-reference entry (browsable/searchable in the rules section). */
export interface RuleEntry {
	id: string;
	section: string;
	title: string;
	/** Markdown body. */
	body: string;
	tags: string[];
}

// ---------------------------------------------------------------------------
// Tarot deck + resolution
// ---------------------------------------------------------------------------

export interface TarotConfig {
	suits: SuitId[];
	ranks: TarotRank[];
	majorArcana: MajorArcanaCard[];
	/** Cards drawn into a starting hand where the rules call for one. */
	handSize: number;
	/** Test-of-fate thresholds (card value + attribute). */
	resolution: ResolutionRules;
}

export interface TarotRank {
	id: RankId;
	label: string;
	/** Value added to the attribute on a test of fate. */
	numeric: number;
	court: boolean;
}

export interface MajorArcanaCard {
	id: string;
	number: number;
	name: string;
	upright?: string;
	reversed?: string;
}

/**
 * Data-driven test-of-fate outcome bands, so the real thresholds are content,
 * not code. HMTW: total 14+ is a success, 13- is a failure, with great
 * success/failure edge cases.
 */
export interface ResolutionRules {
	successThreshold: number;
	/** Drawing the tested suit on the initial draw upgrades to a great success. */
	greatSuccessOnMatchingSuit: boolean;
	outcomes: ResolutionOutcome[];
}

export interface ResolutionOutcome {
	id: string;
	label: string;
	description: string;
}

// ---------------------------------------------------------------------------
// Creation rules
// ---------------------------------------------------------------------------

export interface CreationRules {
	/** The attribute spread assigned across suits (default [4, 3, 2, 1]). */
	attributeSpread: number[];
	/** When true, the highest value is fixed to the chosen path's suit. */
	highestAttributeFromPath: boolean;
	/** Omphalic Market allowance at creation. */
	marketAllowance: {
		luxurious: number;
		common: number;
		/** null = unlimited (impoverished items). */
		impoverished: number | null;
	};
	/** Number of motifs an adventurer has (canonically three). */
	motifCount: number;
	/** Starting Resolve points. */
	startingResolve: number;
	/** Number of path talents mastered at creation (the rest are in training). */
	masteredPathTalents: number;
}
