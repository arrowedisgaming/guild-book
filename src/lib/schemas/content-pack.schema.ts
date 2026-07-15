import { z } from 'zod';
import { SUIT_IDS, RANK_IDS, ITEM_TIERS } from '$lib/types/common';

/**
 * Zod mirrors of the content-pack types. Stable system unions (suits, ranks,
 * tiers) use `z.enum`; every content-authored id stays `z.string()` so
 * replacing the placeholder pack with real rulebook data never requires a
 * schema edit.
 */

const suitEnum = z.enum(SUIT_IDS);
const rankEnum = z.enum(RANK_IDS);
const tierEnum = z.enum(ITEM_TIERS);

export const attributeDefinitionSchema = z.object({
	id: suitEnum,
	name: z.string(),
	suit: suitEnum,
	description: z.string(),
	archetype: z.string().optional(),
	min: z.number(),
	max: z.number()
});

export const tarotRankSchema = z.object({
	id: rankEnum,
	label: z.string(),
	numeric: z.number(),
	court: z.boolean()
});

export const majorArcanaCardSchema = z.object({
	id: z.string(),
	number: z.number(),
	name: z.string(),
	upright: z.string().optional(),
	reversed: z.string().optional()
});

export const resolutionOutcomeSchema = z.object({
	id: z.string(),
	label: z.string(),
	description: z.string()
});

export const tarotConfigSchema = z.object({
	suits: z.array(suitEnum),
	ranks: z.array(tarotRankSchema),
	majorArcana: z.array(majorArcanaCardSchema),
	handSize: z.number(),
	resolution: z.object({
		successThreshold: z.number(),
		greatSuccessOnMatchingSuit: z.boolean(),
		outcomes: z.array(resolutionOutcomeSchema)
	})
});

export const creationRulesSchema = z.object({
	attributeSpread: z.array(z.number()),
	highestAttributeFromPath: z.boolean(),
	marketAllowance: z.object({
		luxurious: z.number(),
		common: z.number(),
		impoverished: z.number().nullable()
	}),
	motifCount: z.number(),
	startingResolve: z.number(),
	masteredPathTalents: z.number()
});

export const contentPackFilesSchema = z.object({
	kiths: z.string(),
	paths: z.string(),
	talents: z.string(),
	items: z.string(),
	motifs: z.string().optional(),
	languages: z.string().optional(),
	conditions: z.string().optional(),
	afflictions: z.string().optional(),
	rules: z.string().optional(),
	spells: z.string().optional(),
	denizens: z.string().optional(),
	tarotProcedures: z.string()
});

export const encumbranceConfigSchema = z.object({
	handSlots: z.number(),
	beltSlots: z.number(),
	packSlots: z.number()
});

/** The manifest (index.json). */
export const contentPackSchema = z.object({
	id: z.string(),
	name: z.string(),
	version: z.string(),
	description: z.string(),
	system: z.literal('hmtw'),
	license: z.string(),
	authors: z.array(z.string()),
	files: contentPackFilesSchema,
	attributes: z.array(attributeDefinitionSchema),
	tarot: tarotConfigSchema,
	creation: creationRulesSchema,
	encumbrance: encumbranceConfigSchema
});

// --- Collection files -------------------------------------------------------

export const kinDefinitionSchema = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string(),
	masteredTalentId: z.string(),
	areteTalentId: z.string().optional(),
	sampleNames: z.array(z.string()).optional()
});

export const kithDefinitionSchema = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string(),
	areteTriggers: z.array(z.string()),
	kins: z.array(kinDefinitionSchema)
});

export const pathDefinitionSchema = z.object({
	id: z.string(),
	name: z.string(),
	suit: suitEnum,
	description: z.string(),
	talentIds: z.array(z.string())
});

export const talentDefinitionSchema = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string(),
	source: z.enum(['kin', 'path', 'arete', 'general']),
	requiredItemIds: z.array(z.string()).optional()
});

export const itemDefinitionSchema = z.object({
	id: z.string(),
	name: z.string(),
	tier: tierEnum,
	category: z.string(),
	description: z.string(),
	slots: z.number().optional(),
	carry: z.enum(['any', 'belt-only', 'hand']).optional(),
	wornBeltSlots: z.number().optional(),
	notches: z.number().optional(),
	stack: z.object({ per: z.number(), unit: z.string().optional() }).optional(),
	properties: z.array(z.string()).optional(),
	stats: z.record(z.string(), z.union([z.string(), z.number()])).optional()
});

export const afflictionStageSchema = z.object({
	stage: z.number(),
	effect: z.string(),
	cureCost: z.number().nullable()
});

export const afflictionDefinitionSchema = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string().optional(),
	stages: z.array(afflictionStageSchema).min(1)
});

export const motifTablesSchema = z.object({
	descriptors: z.array(z.string()),
	professions: z.array(z.string())
});

export const namedEntrySchema = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string().optional()
});

// --- Dungeon denizens (Appendix C) -------------------------------------------

/** Stats are usually numbers; strings ("∞", "X") render verbatim. */
const denizenStatValueSchema = z.union([z.number().finite(), z.string().trim().min(1)]);

/** Health starts at 1+ (the bloodybones' "∞" is a string); Defense may be 0. */
const denizenHealthSchema = z.union([z.number().finite().min(1), z.string().trim().min(1)]);
const denizenDefenseSchema = z.union([z.number().finite().min(0), z.string().trim().min(1)]);

/** Health and Defense always travel as a pair — never a half-pair. */
function requireHdPair(
	value: { health?: unknown; defense?: unknown },
	ctx: z.RefinementCtx
): void {
	if ((value.health === undefined) !== (value.defense === undefined)) {
		ctx.addIssue({ code: 'custom', message: 'Health and Defense must be provided together' });
	}
}

const denizenAttributesSchema = z.object({
	swords: denizenStatValueSchema,
	pentacles: denizenStatValueSchema,
	cups: denizenStatValueSchema,
	wands: denizenStatValueSchema
});

const denizenAbilitySchema = z.object({
	name: z.string(),
	text: z.string()
});

export const denizenThemeSchema = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string(),
	likes: z.array(z.string()).optional(),
	hates: z.array(z.string()).optional(),
	notes: z.array(denizenAbilitySchema).optional(),
	lesserDooms: z.array(denizenAbilitySchema).optional(),
	chooseLesserDooms: z.string().optional(),
	builderMode: z.enum(['standard', 'unsupported']).optional(),
	builderNote: z.string().optional()
});

export const denizenThreatSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		description: z.string(),
		attributes: denizenAttributesSchema.optional(),
		health: denizenHealthSchema.optional(),
		defense: denizenDefenseSchema.optional(),
		statNote: z.string().optional(),
		notes: z.array(denizenAbilitySchema).optional(),
		notesOptional: z.boolean().optional(),
		greaterDooms: z.array(denizenAbilitySchema).optional(),
		chooseGreaterDooms: z.string().optional(),
		builderMode: z.enum(['standard', 'pools', 'unsupported']).optional(),
		builderNote: z.string().optional()
	})
	.superRefine(requireHdPair);

const denizenPoolSchema = z.object({
	id: z.string(),
	name: z.string(),
	health: denizenHealthSchema,
	defense: denizenDefenseSchema,
	text: z.string().optional(),
	notes: z.array(denizenAbilitySchema).optional(),
	lesserDooms: z.array(denizenAbilitySchema).optional(),
	greaterDooms: z.array(denizenAbilitySchema).optional()
});

const denizenSidebarSchema = z.object({
	title: z.string(),
	body: z.string()
});

export const denizenDefinitionSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		theme: z.string(),
		threat: z.string(),
		flavor: z.string(),
		attributes: denizenAttributesSchema,
		health: denizenHealthSchema.optional(),
		defense: denizenDefenseSchema.optional(),
		statNote: z.string().optional(),
		likes: z.array(z.string()).optional(),
		hates: z.array(z.string()).optional(),
		notes: z.array(denizenAbilitySchema).optional(),
		lesserDooms: z.array(denizenAbilitySchema).optional(),
		greaterDooms: z.array(denizenAbilitySchema).optional(),
		specialRules: z.string().optional(),
		pools: z.array(denizenPoolSchema).optional(),
		sidebars: z.array(denizenSidebarSchema).optional()
	})
	.superRefine((denizen, ctx) => {
		requireHdPair(denizen, ctx);
		if (denizen.health === undefined && (denizen.pools?.length ?? 0) === 0) {
			ctx.addIssue({
				code: 'custom',
				message: 'A denizen needs either top-level Health/Defense or at least one pool'
			});
		}
	});

export const denizensFileSchema = z.object({
	themes: z.array(denizenThemeSchema),
	threats: z.array(denizenThreatSchema),
	bestiary: z.array(denizenDefinitionSchema)
});

export const ruleEntrySchema = z.object({
	id: z.string(),
	section: z.string(),
	title: z.string(),
	body: z.string(),
	tags: z.array(z.string())
});

export const spellDefinitionSchema = z.object({
	id: z.string(),
	name: z.string(),
	// Content-authored id (wastes | weald | weird | welkin) — kept as z.string()
	// so the four sorcery traditions stay data, not a schema union.
	tradition: z.string(),
	component: z.string(),
	description: z.string()
});

export const kithsFileSchema = z.array(kithDefinitionSchema);
export const pathsFileSchema = z.array(pathDefinitionSchema);
export const talentsFileSchema = z.array(talentDefinitionSchema);
export const itemsFileSchema = z.array(itemDefinitionSchema);
export const languagesFileSchema = z.array(namedEntrySchema);
export const conditionsFileSchema = z.array(namedEntrySchema);
export const afflictionsFileSchema = z.array(afflictionDefinitionSchema);
export const rulesFileSchema = z.array(ruleEntrySchema);
export const spellsFileSchema = z.array(spellDefinitionSchema);

// ---------------------------------------------------------------------------
// In-session tarot procedures + oracle lookup tables
// ---------------------------------------------------------------------------

/** At least one of heading/anchor: the Appendix D Special City Actions are
 *  bullet items with no heading of their own. */
const tarotSourceRefSchema = z
	.object({
		file: z.string(),
		heading: z.string().optional(),
		after: z.string().optional(),
		anchor: z.string().optional()
	})
	.refine((s) => Boolean(s.heading || s.anchor), {
		message: 'source needs a heading or an anchor'
	});

const tarotDeckIdEnum = z.enum(['major', 'minor']);

/** `fresh` draws a newly shuffled deck unrelated to the campaign decks: outside
 *  card conservation, never exhausts, cannot trigger a Fool reshuffle. */
const tarotDeckScopeEnum = z.enum(['session', 'fresh']);

const tarotProcedurePhaseEnum = z.enum(['crawl', 'challenge', 'camp', 'city', 'cross-phase']);

const tarotProcedureScopeEnum = z.enum([
	'supported-v1',
	'deferred-preparation',
	'not-applicable-non-tarot'
]);

const tarotOperationEnum = z.enum([
	'draw',
	'deal',
	'play',
	'place-facedown',
	'reveal',
	'discard',
	'transfer',
	'select-from-discard',
	'reorder-top',
	'mulligan',
	'consult-discard-top',
	'manual-choice'
]);

const tarotDrawSpecSchema = z.union([
	z.object({ kind: z.literal('fixed'), count: z.number().int().positive() }),
	z.object({ kind: z.literal('formula'), formulaId: z.string() })
]);

const tarotProcedureStepDefinitionSchema = z.object({
	id: z.string(),
	actor: z.enum(['gm', 'player', 'system']),
	operation: tarotOperationEnum,
	deck: tarotDeckIdEnum.optional(),
	deckScope: tarotDeckScopeEnum.optional(),
	draw: tarotDrawSpecSchema.optional(),
	lookupTableId: z.string().optional(),
	visibility: z.enum(['public', 'actor-private', 'recipient-private']),
	resultVisibility: z.enum(['public', 'actor-private', 'gm-private']),
	completion: z.enum(['automatic', 'actor-confirmed', 'gm-confirmed']),
	recovery: z.enum(['discard-pending', 'return-to-draw', 'retain-pending'])
});

export const tarotProcedureDefinitionSchema = z.object({
	id: z.string(),
	title: z.string(),
	phase: tarotProcedurePhaseEnum,
	scope: tarotProcedureScopeEnum,
	source: tarotSourceRefSchema,
	ruleEntryIds: z.array(z.string()),
	steps: z.array(tarotProcedureStepDefinitionSchema),
	modifierIds: z.array(z.string())
});

const tarotLookupKeySchema = z.union([
	z.object({ kind: z.literal('card-range'), from: z.string(), to: z.string() }),
	z.object({ kind: z.literal('suit'), suit: suitEnum })
]);

const tarotLookupTokenEnum = z.enum(['value', 'suit', 'odd', 'even', 'discard', 'adventurers']);

const tarotLookupCellSchema = z.object({
	columnId: z.string(),
	text: z.string().min(1),
	tokens: z.array(tarotLookupTokenEnum),
	references: z.array(
		z.object({
			collection: z.enum(['denizens', 'alchemy', 'rules']),
			entryId: z.string(),
			label: z.string()
		})
	)
});

export const tarotLookupTableSchema = z.object({
	id: z.string(),
	title: z.string(),
	deck: tarotDeckIdEnum,
	deckScope: tarotDeckScopeEnum.optional(),
	axis: z.enum(['card', 'card-by-suit', 'suit-by-step']),
	columns: z.array(z.object({ id: z.string(), label: z.string() })).min(1),
	rows: z.array(z.object({ key: tarotLookupKeySchema, cells: z.array(tarotLookupCellSchema) })).min(1),
	source: tarotSourceRefSchema
});

export const sessionModifierDefinitionSchema = z.object({
	id: z.string(),
	title: z.string(),
	phase: tarotProcedurePhaseEnum,
	source: tarotSourceRefSchema,
	ruleEntryIds: z.array(z.string()),
	behaviorId: z.string(),
	params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()]))
});

export const tarotFormulaDefinitionSchema = z.object({
	id: z.string(),
	title: z.string(),
	source: tarotSourceRefSchema,
	ruleEntryIds: z.array(z.string()),
	params: z.record(z.string(), z.number())
});

export const tarotProceduresFileSchema = z.object({
	schemaVersion: z.literal(1),
	procedures: z.array(tarotProcedureDefinitionSchema),
	lookupTables: z.array(tarotLookupTableSchema),
	modifiers: z.array(sessionModifierDefinitionSchema),
	formulas: z.array(tarotFormulaDefinitionSchema)
});

/**
 * Parse `value` against `schema`, throwing a labelled error on failure.
 * Used by the content loader so a malformed pack fails loudly at load time
 * rather than surfacing as a confusing runtime error deep in the wizard.
 */
export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
	const result = schema.safeParse(value);
	if (!result.success) {
		throw new Error(`Invalid ${label}: ${result.error.message}`);
	}
	return result.data;
}
