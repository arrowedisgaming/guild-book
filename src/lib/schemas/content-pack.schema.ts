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

const doomTierBandSchema = z.object({
	from: z.number().int(),
	to: z.number().int(),
	ruleEntryId: z.string()
});

const groupOutcomeBandSchema = z.object({
	id: z.string(),
	label: z.string(),
	from: z.number().int(),
	to: z.number().int(),
	description: z.string()
});

/**
 * The 22 major arcana: exactly one Fool at 0, and I–XXI exactly once each. A
 * duplicate or missing number would silently corrupt the GM deck, so it fails
 * at load rather than at the table.
 */
function requireCompleteMajorArcana(cards: { id: string; number: number }[], ctx: z.RefinementCtx) {
	if (new Set(cards.map((c) => c.id)).size !== cards.length) {
		ctx.addIssue({ code: 'custom', message: 'major arcana ids must be unique' });
	}
	const fools = cards.filter((c) => c.id === 'fool');
	if (fools.length !== 1 || fools[0].number !== 0) {
		ctx.addIssue({ code: 'custom', message: 'expected exactly one `fool` with number 0' });
	}
	const numbered = cards.filter((c) => c.id !== 'fool').map((c) => c.number);
	const expected = Array.from({ length: 21 }, (_, i) => i + 1);
	if (numbered.length !== 21 || expected.some((n) => !numbered.includes(n))) {
		ctx.addIssue({ code: 'custom', message: 'expected majors numbered 1–21 exactly once each' });
	}
}

/** Two tests yield -2..4 hits; every reachable total needs exactly one band. */
function requireTotalGroupCoverage(
	bands: { id: string; from: number; to: number }[],
	ctx: z.RefinementCtx
) {
	for (let hits = -2; hits <= 4; hits++) {
		const matches = bands.filter((b) => hits >= b.from && hits <= b.to);
		if (matches.length !== 1) {
			ctx.addIssue({
				code: 'custom',
				message: `group hit total ${hits} matches ${matches.length} outcome bands, expected exactly 1`
			});
		}
	}
}

export const tarotConfigSchema = z.object({
	suits: z.array(suitEnum),
	ranks: z.array(tarotRankSchema),
	majorArcana: z.array(majorArcanaCardSchema).superRefine(requireCompleteMajorArcana),
	doomTiers: z.object({ lesser: doomTierBandSchema, greater: doomTierBandSchema }),
	handSize: z.number(),
	resolution: z.object({
		successThreshold: z.number(),
		greatSuccessOnMatchingSuit: z.boolean(),
		outcomes: z.array(resolutionOutcomeSchema),
		favorModifier: z.number().int().positive(),
		groupOutcomes: z.array(groupOutcomeBandSchema).superRefine(requireTotalGroupCoverage)
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
	contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
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

const tarotProcedurePhaseEnum = z.enum(['crawl', 'challenge', 'camp', 'city', 'cross-phase']);

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

const tarotCardProvenanceEnum = z.enum(['procedure-draw', 'test-draw', 'supplied']);

const tarotCardSourceRuleSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('draw-pile'),
		deck: tarotDeckIdEnum,
		provenance: tarotCardProvenanceEnum
	}),
	z.object({ kind: z.literal('discard-top'), deck: tarotDeckIdEnum, consume: z.boolean() }),
	z.object({ kind: z.literal('discard-selection'), deck: tarotDeckIdEnum }),
	z.object({
		kind: z.literal('mixed'),
		deck: tarotDeckIdEnum,
		sources: z.tuple([z.literal('draw-pile'), z.literal('discard-top')])
	})
]);

const tarotStepConditionSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('lookup-key'),
		tableId: z.string(),
		keys: z.tuple([z.string()]).rest(z.string())
	}),
	z.object({
		kind: z.literal('card-suit'),
		suits: z.tuple([suitEnum]).rest(suitEnum)
	}),
	z.object({
		kind: z.literal('value-range'),
		from: z.string(),
		to: z.string(),
		include: z.boolean()
	}),
	z.object({ kind: z.literal('entry-state'), state: z.enum(['unused', 'used']) }),
	z.object({ kind: z.literal('game-state'), state: z.literal('guild-out-of-light') }),
	z.object({
		kind: z.literal('percent-chance'),
		percent: z.number().int().min(1).max(99)
	}),
	z.object({
		kind: z.literal('previous-result'),
		result: z.enum(['success', 'failure', 'random-encounter', 'non-encounter'])
	})
]);

const tarotStepChoiceSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('accept-or-decline'),
		acceptStepId: z.string(),
		declineStepId: z.string()
	}),
	z.object({
		kind: z.literal('choose-one'),
		fromStepId: z.string(),
		count: z.number().int().positive(),
		rejectConditions: z.array(tarotStepConditionSchema).optional()
	}),
	z.object({
		kind: z.literal('choose-lookup-table'),
		selector: z.literal('far-realm'),
		tableIds: z.tuple([z.string()]).rest(z.string())
	}),
	z.object({
		kind: z.literal('mixed-source'),
		sources: z.tuple([z.literal('draw-pile'), z.literal('discard-top')])
	})
]);

const tarotAmountSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('fixed'), value: z.number() }),
	z.object({ kind: z.literal('card-value') }),
	z.object({ kind: z.literal('card-value-plus-attribute'), attribute: suitEnum }),
	z.object({ kind: z.literal('formula'), formulaId: z.string() }),
	z.object({ kind: z.literal('full') })
]);

const tarotCardZoneEnum = z.enum([
	'draw-pile',
	'discard',
	'hand',
	'initiative',
	'facedown',
	'inspiration',
	'table'
]);

const tarotStepEffectSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('resource'),
		resource: z.enum(['gold', 'resolve', 'charges', 'visions']),
		amount: tarotAmountSchema
	}),
	z.object({
		kind: z.literal('test-modifier'),
		modifier: z.enum(['favor', 'disfavor']),
		appliesTo: z.enum(['attack', 'test-of-fate'])
	}),
	z.object({
		kind: z.literal('test-bonus'),
		amount: z.number().int(),
		appliesTo: z.enum(['known-action', 'attack', 'test-of-fate'])
	}),
	z.object({ kind: z.literal('affliction-cure'), charges: z.number().int().positive() }),
	z.object({
		kind: z.literal('teeth-loss'),
		from: z.number().int().positive(),
		to: z.number().int().positive()
	}),
	z.object({ kind: z.literal('bound-by-fate') }),
	z.object({ kind: z.literal('mark-entry-used') }),
	z.object({ kind: z.literal('no-op') }),
	z.object({ kind: z.literal('card-movement'), from: tarotCardZoneEnum, to: tarotCardZoneEnum })
]);

const tarotStepCostSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('resource'),
		resource: z.enum(['gold', 'resolve', 'charges']),
		amount: z.number().int().positive(),
		timing: z.enum(['before-step', 'per-use', 'per-watch'])
	}),
	z.object({
		kind: z.literal('action-budget'),
		budget: z.enum(['challenge', 'miscellaneous'])
	})
]);

const tarotUsageLimitSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('per-round'), count: z.number().int().positive() }),
	z.object({ kind: z.literal('per-session'), count: z.number().int().positive() }),
	z.object({ kind: z.literal('per-watch'), count: z.number().int().positive() }),
	z.object({ kind: z.literal('max-held'), count: z.number().int().positive() }),
	z.object({ kind: z.literal('single-instance'), count: z.literal(1) }),
	z.object({ kind: z.literal('once-next-expedition'), count: z.literal(1) })
]);

const tarotStepTimingSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('immediate') }),
	z.object({
		kind: z.literal('event'),
		event: z.enum(['city-phase-end', 'waking', 'eating', 'nightly', 'prophecy-fulfilled'])
	})
]);

const tarotDurationRuleSchema = z.object({
	kind: z.literal('until'),
	boundary: z.enum([
		'used',
		'round-end',
		'session-end',
		'next-attack',
		'next-expedition-end',
		'spell-dismissed-or-countered'
	])
});

const tarotReshuffleRuleSchema = z.object({
	trigger: z.literal('fool-drawn'),
	decks: z.tuple([z.literal('minor'), z.literal('major')]),
	boundary: z.enum(['test-resolution', 'challenge-round-end'])
});

const tarotProcedureStepDefinitionSchema = z
	.object({
		id: z.string(),
		actor: z.enum(['gm', 'player', 'each-player', 'system']),
		operation: tarotOperationEnum,
		deck: tarotDeckIdEnum.optional(),
		draw: tarotDrawSpecSchema.optional(),
		precondition: z.enum(['previous-step-failed']).optional(),
		lookupTableId: z.string().optional(),
		lookupTableIds: z.tuple([z.string()]).rest(z.string()).optional(),
		cardSource: tarotCardSourceRuleSchema.optional(),
		conditions: z.array(tarotStepConditionSchema).optional(),
		choice: tarotStepChoiceSchema.optional(),
		effects: z.array(tarotStepEffectSchema).optional(),
		costs: z.array(tarotStepCostSchema).optional(),
		limits: z.array(tarotUsageLimitSchema).optional(),
		timing: tarotStepTimingSchema.optional(),
		duration: tarotDurationRuleSchema.optional(),
		reshuffle: tarotReshuffleRuleSchema.optional(),
		visibility: z.enum(['public', 'actor-private', 'recipient-private']),
		resultVisibility: z.enum(['public', 'actor-private', 'gm-private']),
		completion: z.enum(['automatic', 'actor-confirmed', 'gm-confirmed']),
		recovery: z.enum(['discard-pending', 'return-to-draw', 'retain-pending'])
	})
	.superRefine((step, context) => {
		if (step.lookupTableId && step.lookupTableIds) {
			context.addIssue({
				code: 'custom',
				message: 'a step cannot use both lookupTableId and lookupTableIds',
				path: ['lookupTableIds']
			});
		}
		if (step.deck && step.cardSource && step.deck !== step.cardSource.deck) {
			context.addIssue({
				code: 'custom',
				message: 'cardSource deck must match step deck',
				path: ['cardSource', 'deck']
			});
		}
	});

export const tarotProcedureDefinitionSchema = z.object({
	id: z.string(),
	title: z.string(),
	phase: tarotProcedurePhaseEnum,
	scope: z.literal('supported-v1'),
	source: tarotSourceRefSchema,
	invokedFrom: z.tuple([tarotSourceRefSchema]).rest(tarotSourceRefSchema),
	ruleEntryIds: z.array(z.string()),
	steps: z.array(tarotProcedureStepDefinitionSchema),
	modifierIds: z.array(z.string())
});

const tarotLookupKeySchema = z.union([
	z.object({ kind: z.literal('card-range'), from: z.string(), to: z.string() }),
	z.object({ kind: z.literal('suit'), suit: suitEnum })
]);

/** Typed discard-top references; see TarotLookupToken. */
const tarotLookupTokenSchema = z.union([
	z.object({ kind: z.literal('value') }),
	z.object({ kind: z.literal('parity'), parity: z.enum(['odd', 'even']) }),
	z.object({ kind: z.literal('suit'), suit: suitEnum }),
	z.object({ kind: z.literal('range'), from: z.string(), to: z.string() })
]);

const tarotLookupCellSchema = z.object({
	columnId: z.string(),
	text: z.string().min(1),
	tokens: z.array(tarotLookupTokenSchema),
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
	bracketConvention: z.literal('minor-discard-top').optional(),
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
	schemaVersion: z.literal(2),
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
