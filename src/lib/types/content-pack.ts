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
	/**
	 * SHA-256 over every generated content file in manifest-key order. CI uses it
	 * to prove committed output was not hand-edited, and to require a version bump
	 * whenever content changes — a session pins its pack version, so generated
	 * content must never change under a version it already served.
	 */
	contentDigest: string;
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
	spells?: string;
	denizens?: string;
	tarotProcedures: string;
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

// ---------------------------------------------------------------------------
// Dungeon denizens (Appendix C) — themes, threats, bestiary
// ---------------------------------------------------------------------------

/**
 * A stat that is usually a number but occasionally book-special: the slime's
 * attributes are "X" (equal to current Health), the bloodybones' Health is
 * "∞". Strings render verbatim; `statNote` on the owner explains them.
 */
export type DenizenStatValue = number | string;

/** The four suit-attributes as a creature block. */
export interface DenizenAttributes {
	swords: DenizenStatValue;
	pentacles: DenizenStatValue;
	cups: DenizenStatValue;
	wands: DenizenStatValue;
}

/** A named ability — a note, lesser doom, or greater doom. Text is Markdown. */
export interface DenizenAbility {
	name: string;
	text: string;
}

/**
 * A theme — the creature's mythological context (Beast, Undead, …). Provides
 * likes/hates, standing notes, and default lesser dooms. The Man theme is a
 * description only (the book says to build people as characters instead).
 */
export interface DenizenThemeDefinition {
	id: string;
	name: string;
	description: string;
	likes?: string[];
	hates?: string[];
	notes?: DenizenAbility[];
	lesserDooms?: DenizenAbility[];
	/** Pick guidance verbatim from the book, e.g. "Choose 1 of the following". */
	chooseLesserDooms?: string;
	/**
	 * Whether the builder can use this template. Omitted = 'standard'.
	 * 'person' switches the builder to the adversary path (the Man theme:
	 * the book builds people as characters — spread attributes, kith, and
	 * gimmick dooms). 'unsupported' keeps the template in the reference but
	 * out of the builder.
	 */
	builderMode?: 'standard' | 'person' | 'unsupported';
	/** Guidance shown on the template's builder card. */
	builderNote?: string;
}

/**
 * A threat — the creature's strength and tactics (Minion … Dungeon Lord).
 * Provides attributes, Health/Defense, and default greater dooms.
 */
export interface DenizenThreatDefinition {
	id: string;
	name: string;
	description: string;
	/** Omitted for threats without a fixed block (dungeon lord HD is special). */
	attributes?: DenizenAttributes;
	health?: DenizenStatValue;
	defense?: DenizenStatValue;
	/** Explains irregular stats — stat-block content that survives export. */
	statNote?: string;
	/**
	 * Build-time pick instruction verbatim from the book, e.g. "Choose 1
	 * attribute to increase to 6." — guidance while building, never part of
	 * the finished stat block.
	 */
	chooseAttribute?: string;
	notes?: DenizenAbility[];
	/** The book marks some threat notes optional ("(Optional)"). */
	notesOptional?: boolean;
	greaterDooms?: DenizenAbility[];
	/** Pick guidance verbatim from the book, e.g. "Choose 1 or 2". */
	chooseGreaterDooms?: string;
	/**
	 * Whether the builder can use this template. Omitted = 'standard'.
	 * 'pools' marks threats fought in named Health/Defense pools (dungeon
	 * lords); the builder disables them until it supports pool editing, while
	 * the reference keeps showing them in full.
	 */
	builderMode?: 'standard' | 'pools' | 'unsupported';
	/** Shown in the builder when the template is unavailable. */
	builderNote?: string;
}

/**
 * A named Health/Defense pool. Dungeon lords are fought in sections (the
 * Sporehulk's legs/arms/torso, the Yellow King's body/crown/phylactery), each
 * with its own HD and abilities. When a bestiary entry has pools, they replace
 * its top-level health/defense.
 */
export interface DenizenPool {
	id: string;
	name: string;
	/** Present as a pair or not at all — a half-pair pool omits both (like top-level HD). */
	health?: DenizenStatValue;
	defense?: DenizenStatValue;
	/** Markdown — what defeating (or wearing, or burning…) this pool means. */
	text?: string;
	notes?: DenizenAbility[];
	lesserDooms?: DenizenAbility[];
	greaterDooms?: DenizenAbility[];
}

/** An attached extra (the face rat's disease, vampire-slaying rumors…). */
export interface DenizenSidebar {
	title: string;
	/** Markdown. */
	body: string;
}

/** A pre-made creature from the bestiary. */
export interface DenizenDefinition {
	id: string;
	name: string;
	/** Theme id (must resolve within the themes collection). */
	theme: string;
	/**
	 * Threat id (must resolve within the threats collection). Bestiary entries
	 * always have one (the Zod schema requires it); builder-made people omit
	 * it — the book builds people as characters, not theme + threat.
	 */
	threat?: string;
	/** Markdown flavor text, reproduced from the book (open content). */
	flavor: string;
	attributes: DenizenAttributes;
	health?: DenizenStatValue;
	defense?: DenizenStatValue;
	/** Explains irregular stats (slime's "X", bloodybones' "∞"). */
	statNote?: string;
	likes?: string[];
	hates?: string[];
	notes?: DenizenAbility[];
	lesserDooms?: DenizenAbility[];
	greaterDooms?: DenizenAbility[];
	/** Markdown — fight-changing rules that precede the pools (dungeon lords). */
	specialRules?: string;
	pools?: DenizenPool[];
	sidebars?: DenizenSidebar[];
}

/**
 * The simple-HD defaults a person draft seeds with (a sturdy commoner).
 * The attribute spread is not repeated here — people use the adventurer
 * spread, `creation.attributeSpread` in index.json.
 */
export interface DenizenPersonDefaults {
	health: DenizenStatValue;
	defense: DenizenStatValue;
}

/** The denizens.json collection: templates plus the pre-made bestiary. */
export interface DenizensFile {
	themes: DenizenThemeDefinition[];
	threats: DenizenThreatDefinition[];
	bestiary: DenizenDefinition[];
	/** Seed data for the builder's person path (themes with builderMode 'person'). */
	person: DenizenPersonDefaults;
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

/** A sorcery spell from one of the four traditions (wastes | weald | weird | welkin). */
export interface SpellDefinition {
	id: string;
	name: string;
	tradition: string;
	/** The material component (verbatim). */
	component: string;
	/** Markdown effect text. */
	description: string;
}

// ---------------------------------------------------------------------------
// Tarot deck + resolution
// ---------------------------------------------------------------------------

export interface TarotConfig {
	suits: SuitId[];
	ranks: TarotRank[];
	majorArcana: MajorArcanaCard[];
	/** Which major values are lesser vs greater Dooms. Ch7 states the boundary. */
	doomTiers: DoomTierConfig;
	/** Cards drawn into a starting hand where the rules call for one. */
	handSize: number;
	/** Test-of-fate thresholds (card value + attribute). */
	resolution: ResolutionRules;
}

/**
 * Doom tiers, keyed by major-arcana value. The boundary is a game rule, not an
 * engine constant: Ch7 — "Lesser doom cards have values of 1–14" / "Greater doom
 * cards have values of 15–21". `ruleEntryId` cites the rules entry it came from.
 */
export interface DoomTierConfig {
	lesser: DoomTierBand;
	greater: DoomTierBand;
}

export interface DoomTierBand {
	from: number;
	to: number;
	ruleEntryId: string;
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
/** One band of the group-test hit table (Ch1 "Group tests"). */
export interface GroupOutcomeBand {
	id: string;
	label: string;
	/** Inclusive hit range. Two tests can total -2..4. */
	from: number;
	to: number;
	description: string;
}

export interface ResolutionRules {
	successThreshold: number;
	/** Drawing the tested suit on the initial draw upgrades to a great success. */
	greatSuccessOnMatchingSuit: boolean;
	outcomes: ResolutionOutcome[];
	/**
	 * What favor adds and disfavor subtracts. Ch1: "Favor grants +3 to the total
	 * value"; each is non-cumulative and one cancels the other.
	 */
	favorModifier: number;
	/** The group-test hit table. Bands must partition -2..4 with no overlap. */
	groupOutcomes: GroupOutcomeBand[];
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

// ---------------------------------------------------------------------------
// In-session tarot procedures + oracle lookup tables
// ---------------------------------------------------------------------------

/**
 * Every in-session tarot procedure the campaign shared table runs, and the
 * verbatim oracle tables those procedures resolve against. Generated by
 * `scripts/content-import/md-procedures.mjs` from a committed manifest and the
 * Markdown vault — never hand-authored.
 *
 * Preparation tooling (city/dungeon generators, the Job Board) is out of scope:
 * the boundary is the moment of use. Rules that specify a flat random chance
 * without tarot stay manual and are recorded as `not-applicable-non-tarot`.
 */
export interface TarotProceduresFile {
	schemaVersion: 2;
	procedures: TarotProcedureDefinition[];
	lookupTables: TarotLookupTable[];
	modifiers: SessionModifierDefinition[];
	formulas: TarotFormulaDefinition[];
}

export type TarotProcedurePhase = 'crawl' | 'challenge' | 'camp' | 'city' | 'cross-phase';

/** Audit disposition. Only `supported-v1` reaches the runtime catalog. */
export type TarotProcedureScope =
	| 'supported-v1'
	| 'deferred-preparation'
	| 'not-applicable-non-tarot';

export type TarotDeckId = 'major' | 'minor';

export type TarotOperation =
	| 'draw'
	| 'deal'
	| 'play'
	| 'place-facedown'
	| 'reveal'
	| 'discard'
	| 'transfer'
	| 'select-from-discard'
	| 'reorder-top'
	| 'mulligan'
	| 'consult-discard-top'
	| 'manual-choice';

/** A draw is either a fixed count or a named formula the engine implements. */
export type TarotDrawSpec =
	| { kind: 'fixed'; count: number }
	| { kind: 'formula'; formulaId: string };

/** Where a step's result becomes visible once resolved. */
export type TarotResultVisibility = 'public' | 'actor-private' | 'gm-private';

/** Guards a step that is not always legal. */
export type TarotStepPrecondition = 'previous-step-failed';

/** What happens to a partially-resolved step when a session is recovered or ended. */
export type TarotRecovery = 'discard-pending' | 'return-to-draw' | 'retain-pending';

export type TarotCardProvenance = 'procedure-draw' | 'test-draw' | 'supplied';

export type TarotCardSourceRule =
	| { kind: 'draw-pile'; deck: TarotDeckId; provenance: TarotCardProvenance }
	| { kind: 'discard-top'; deck: TarotDeckId; consume: boolean }
	| { kind: 'discard-selection'; deck: TarotDeckId }
	| { kind: 'mixed'; deck: TarotDeckId; sources: ['draw-pile', 'discard-top'] };

export type TarotStepCondition =
	| { kind: 'lookup-key'; tableId: string; keys: [string, ...string[]] }
	| { kind: 'card-suit'; suits: [SuitId, ...SuitId[]] }
	| { kind: 'value-range'; from: string; to: string; include: boolean }
	| { kind: 'entry-state'; state: 'unused' | 'used' }
	| { kind: 'game-state'; state: 'guild-out-of-light' }
	| { kind: 'invocation-mode'; mode: 'appropriate-realm' | 'random-realm' }
	| { kind: 'percent-chance'; percent: number }
	| {
			kind: 'previous-result';
			result: 'success' | 'failure' | 'random-encounter' | 'non-encounter';
			fromStepId?: string;
			match?: 'any' | 'all';
			count?: number;
	  };

export type TarotStepChoice =
	| { kind: 'accept-or-decline'; acceptStepId: string; declineStepId: string }
	| {
			kind: 'choose-one';
			fromStepId: string;
			count: number;
			rejectConditions?: TarotStepCondition[];
	  }
	| {
			kind: 'choose-lookup-table';
			selector: 'far-realm' | 'random';
			tableIds: [string, ...string[]];
	  }
	| { kind: 'mixed-source'; sources: ['draw-pile', 'discard-top'] };

export type TarotAmount =
	| { kind: 'fixed'; value: number }
	| { kind: 'card-value' }
	| { kind: 'card-value-plus-attribute'; attribute: SuitId }
	| { kind: 'formula'; formulaId: string }
	| { kind: 'full' };

export type TarotCardZone =
	| 'draw-pile'
	| 'discard'
	| 'hand'
	| 'initiative'
	| 'facedown'
	| 'inspiration'
	| 'table';

export type TarotStepEffect =
	| {
			kind: 'resource';
			resource: 'gold' | 'resolve' | 'charges' | 'visions';
			amount: TarotAmount;
	  }
	| {
			kind: 'test-modifier';
			modifier: 'favor' | 'disfavor';
			appliesTo: 'attack' | 'test-of-fate';
	  }
	| {
			kind: 'test-bonus';
			amount: number;
			appliesTo: 'known-action' | 'attack' | 'test-of-fate';
	  }
	| { kind: 'affliction-cure'; charges: number }
	| { kind: 'teeth-loss'; from: number; to: number }
	| { kind: 'bound-by-fate' }
	| { kind: 'mark-entry-used' }
	| { kind: 'no-op' }
	| { kind: 'attract-random-encounters'; destination: 'affected-area' }
	| { kind: 'center-maleficence-on'; target: 'invocation-target' }
	| { kind: 'card-movement'; from: TarotCardZone; to: TarotCardZone };

export type TarotStepCost =
	| {
			kind: 'resource';
			resource: 'gold' | 'resolve' | 'charges';
			amount: number;
			timing: 'before-step' | 'per-use' | 'per-watch';
	  }
	| { kind: 'action-budget'; budget: 'challenge' | 'miscellaneous' };

export type TarotUsageLimit =
	| { kind: 'per-round'; count: number }
	| { kind: 'per-session'; count: number }
	| { kind: 'per-watch'; count: number }
	| { kind: 'max-held'; count: number }
	| { kind: 'single-instance'; count: 1 }
	| { kind: 'once-next-expedition'; count: 1 };

export type TarotStepTiming =
	| { kind: 'immediate' }
	| {
			kind: 'event';
			event: 'city-phase-end' | 'waking' | 'eating' | 'nightly' | 'prophecy-fulfilled';
	  };

export type TarotDurationRule = {
	kind: 'until';
	boundary:
		| 'used'
		| 'round-end'
		| 'session-end'
		| 'next-attack'
		| 'watch-end'
		| 'next-expedition-end'
		| 'spell-dismissed-or-countered';
};

export type TarotReshuffleRule = {
	trigger: 'fool-drawn';
	decks: ['minor', 'major'];
	boundary: 'test-resolution' | 'challenge-round-end';
};

export interface TarotProcedureStepDefinition {
	id: string;
	actor: 'gm' | 'player' | 'each-player' | 'system';
	operation: TarotOperation;
	deck?: TarotDeckId;
	draw?: TarotDrawSpec;
	/**
	 * A step that is only legal in some state. Ch1: pushing fate is offered only
	 * after a failure, so a data-driven runner must not present it unconditionally.
	 */
	precondition?: TarotStepPrecondition;
	/** Set when this step resolves its drawn card(s) against an oracle table. */
	lookupTableId?: string;
	lookupTableIds?: [string, ...string[]];
	cardSource?: TarotCardSourceRule;
	conditions?: TarotStepCondition[];
	choice?: TarotStepChoice;
	effects?: TarotStepEffect[];
	costs?: TarotStepCost[];
	limits?: TarotUsageLimit[];
	timing?: TarotStepTiming;
	duration?: TarotDurationRule;
	reshuffle?: TarotReshuffleRule;
	visibility: 'public' | 'actor-private' | 'recipient-private';
	resultVisibility: TarotResultVisibility;
	completion: 'automatic' | 'actor-confirmed' | 'gm-confirmed';
	recovery: TarotRecovery;
}

export interface TarotProcedureDefinition {
	id: string;
	title: string;
	phase: TarotProcedurePhase;
	scope: 'supported-v1';
	/** Exact rule source. `anchor` addresses a bullet item with no heading. */
	source: TarotSourceRef;
	/** Every call site that materially changes how or when this rule is invoked. */
	invokedFrom: [TarotSourceRef, ...TarotSourceRef[]];
	/** Rules-reference entry ids. Empty when the source is a bullet with no entry. */
	ruleEntryIds: string[];
	steps: TarotProcedureStepDefinition[];
	modifierIds: string[];
}

/**
 * Where a rule lives in the book. At least one of `heading`/`anchor` is always
 * present — several rules (the Appendix D Special City Actions) are bullet items
 * with no heading of their own, so `heading` cannot be required.
 */
export interface TarotSourceRef {
	file: string;
	heading?: string;
	/** Disambiguates a heading that recurs; see md-lib's `after`. */
	after?: string;
	/** Exact leading text of a bullet item. Takes precedence over `heading`. */
	anchor?: string;
}

/**
 * A row key. Card ranges are inclusive and use the source's own numerals, so a
 * We're-Doomed row keyed `I–VII` stays one row rather than being expanded.
 */
export interface TarotLookupKeyRange {
	kind: 'card-range';
	from: string;
	to: string;
}
export interface TarotLookupKeySuit {
	kind: 'suit';
	suit: SuitId;
}
export type TarotLookupKey = TarotLookupKeyRange | TarotLookupKeySuit;

/**
 * A typed reference to the top card of the minor arcana discard pile, per Ch9's
 * bracket convention. The book uses three forms, and a flat enum could not carry
 * the operand of the latter two:
 *   `[value]`          -> that card's value
 *   `[odd]` / `[even]` -> a branch on its parity
 *   `[Swords]` …       -> a branch on its suit
 *   `[1-2]`, `[9-King]`-> a branch on its value range
 */
export type TarotLookupToken =
	| { kind: 'value' }
	| { kind: 'parity'; parity: 'odd' | 'even' }
	| { kind: 'suit'; suit: SuitId }
	| { kind: 'range'; from: string; to: string };

/** A cross-reference the source expressed as a wikilink. */
export interface TarotLookupReference {
	collection: 'denizens' | 'alchemy' | 'rules';
	entryId: string;
	label: string;
}

export interface TarotLookupCell {
	columnId: string;
	/** Verbatim outcome text, extracted rather than retyped. */
	text: string;
	tokens: TarotLookupToken[];
	references: TarotLookupReference[];
}

export interface TarotLookupRow {
	key: TarotLookupKey;
	cells: TarotLookupCell[];
}

/**
 * The three axes the source actually uses:
 * - `card` — one draw selects a row (Meatgrinder, City Events, Hangover, …)
 * - `card-by-suit` — rank selects the row, suit the column (Random Totem, 14×4)
 * - `suit-by-step` — N draws; each card's suit selects a row, step i reads
 *   column i, read left to right (Doomsaying, 4 draws)
 */
export interface TarotLookupTable {
	id: string;
	title: string;
	deck: TarotDeckId;
	/**
	 * Set when the table declares Ch9's bracket convention (`:275`): every bracket
	 * refers to the top card of the minor arcana discard pile. Table-scoped —
	 * Meatgrinder and City Events use brackets as category labels instead.
	 */
	bracketConvention?: 'minor-discard-top';
	axis: 'card' | 'card-by-suit' | 'suit-by-step';
	columns: { id: string; label: string }[];
	rows: TarotLookupRow[];
	source: TarotSourceRef;
}

interface ModifierBase<BehaviorId extends string, Params> {
	id: string;
	title: string;
	phase: TarotProcedurePhase;
	source: TarotSourceRef;
	ruleEntryIds: string[];
	behaviorId: BehaviorId;
	params: Params;
}

export interface InspirationDistributionParams {
	maxHeldPerPlayer: number;
	challengeActionBudget: 'challenge';
	testUse: 'replace-initial-or-push';
	provenance: 'supplied';
	expires: 'used-or-session-end';
}

export interface PreparedFacedownBonusParams {
	requiresBow: boolean;
	suit: SuitId;
	placement: 'facedown';
	targetRequired: boolean;
	revealOn: 'next-bow-attack';
	addsCardValue: boolean;
}

export interface OptionalHandSizeParams {
	normalCards: number;
	optionalCards: number;
	teethLostFrom: number;
	teethLostTo: number;
}

export interface ForcedInitiativeSelectionParams {
	initiativeSelection: 'lowest-value';
	attacksHaveFavor: boolean;
	requiresEmotion: boolean;
	duration: 'concentration';
}

export interface CounselTransferParams {
	timing: 'any-time-during-challenge';
	suitMustMatchAction: boolean;
	maxUsesPerRound: number;
	resolveCostForInterrupt: number;
}

export interface ReplaceInitiativeParams {
	requiresShield: boolean;
	anySuit: boolean;
	actionBudget: 'miscellaneous';
	discardsOldInitiative: boolean;
}

export interface GuardianAngelParams {
	placement: 'facedown';
	allowedActions: 'dodge-or-riposte';
	cumulative: boolean;
	exemptFromFacedownLimit: boolean;
	maxInstances: number;
	targetRequired: boolean;
	duration: 'until-used';
}

export interface ForcedHandDiscardParams {
	immediate: boolean;
	discard: 'entire-hand';
}

/** A typed rule hook a procedure composes; content supplies behavior parameters. */
export type SessionModifierDefinition =
	| ModifierBase<'inspiration-distribution', InspirationDistributionParams>
	| ModifierBase<'prepared-facedown-bonus', PreparedFacedownBonusParams>
	| ModifierBase<'optional-hand-size', OptionalHandSizeParams>
	| ModifierBase<'forced-initiative-selection', ForcedInitiativeSelectionParams>
	| ModifierBase<'private-transfer', CounselTransferParams>
	| ModifierBase<'replace-initiative', ReplaceInitiativeParams>
	| ModifierBase<'guardian-angel-defense', GuardianAngelParams>
	| ModifierBase<'forced-hand-discard', ForcedHandDiscardParams>;

/** Parameters for a named formula the engine implements (e.g. the GM hand size). */
export interface TarotFormulaDefinition {
	id: string;
	title: string;
	source: TarotSourceRef;
	ruleEntryIds: string[];
	params: Record<string, number>;
}
