/**
 * Content-pack loader — exposes the bundled His Majesty the Worm game data from
 * static JSON. Server-side only. JSON is imported (not read from disk) so the
 * pack is bundled and works on Cloudflare Workers, which has no filesystem.
 *
 * Each collection is validated once with Zod and cached as a singleton.
 */

import type {
	GuildBookContentPack,
	KithDefinition,
	PathDefinition,
	TalentDefinition,
	ItemDefinition,
	MotifTables,
	NamedEntry,
	AfflictionDefinition,
	RuleEntry,
	SpellDefinition
} from '$lib/types/content-pack';
import {
	contentPackSchema,
	kithsFileSchema,
	pathsFileSchema,
	talentsFileSchema,
	itemsFileSchema,
	motifTablesSchema,
	languagesFileSchema,
	conditionsFileSchema,
	afflictionsFileSchema,
	rulesFileSchema,
	spellsFileSchema,
	parseOrThrow
} from '$lib/schemas/content-pack.schema';

import indexJson from '../../../../static/content-packs/hmtw/index.json';
import kithsJson from '../../../../static/content-packs/hmtw/kiths.json';
import pathsJson from '../../../../static/content-packs/hmtw/paths.json';
import talentsJson from '../../../../static/content-packs/hmtw/talents.json';
import itemsJson from '../../../../static/content-packs/hmtw/items.json';
import motifsJson from '../../../../static/content-packs/hmtw/motifs.json';
import languagesJson from '../../../../static/content-packs/hmtw/languages.json';
import conditionsJson from '../../../../static/content-packs/hmtw/conditions.json';
import afflictionsJson from '../../../../static/content-packs/hmtw/afflictions.json';
import rulesJson from '../../../../static/content-packs/hmtw/rules.json';
import spellsJson from '../../../../static/content-packs/hmtw/spells.json';

// Singleton caches.
let cachedPack: GuildBookContentPack | null = null;
let cachedKiths: KithDefinition[] | null = null;
let cachedPaths: PathDefinition[] | null = null;
let cachedTalents: TalentDefinition[] | null = null;
let cachedItems: ItemDefinition[] | null = null;
let cachedMotifs: MotifTables | null = null;
let cachedLanguages: NamedEntry[] | null = null;
let cachedConditions: NamedEntry[] | null = null;
let cachedAfflictions: AfflictionDefinition[] | null = null;
let cachedRules: RuleEntry[] | null = null;
let cachedSpells: SpellDefinition[] | null = null;

export function getContentPack(): GuildBookContentPack {
	if (!cachedPack) cachedPack = parseOrThrow(contentPackSchema, indexJson, 'index.json');
	return cachedPack;
}

export function getKiths(): KithDefinition[] {
	if (!cachedKiths) cachedKiths = parseOrThrow(kithsFileSchema, kithsJson, 'kiths.json');
	return cachedKiths;
}

export function getPaths(): PathDefinition[] {
	if (!cachedPaths) cachedPaths = parseOrThrow(pathsFileSchema, pathsJson, 'paths.json');
	return cachedPaths;
}

export function getTalents(): TalentDefinition[] {
	if (!cachedTalents) cachedTalents = parseOrThrow(talentsFileSchema, talentsJson, 'talents.json');
	return cachedTalents;
}

export function getItems(): ItemDefinition[] {
	if (!cachedItems) cachedItems = parseOrThrow(itemsFileSchema, itemsJson, 'items.json');
	return cachedItems;
}

export function getMotifs(): MotifTables {
	if (!cachedMotifs) cachedMotifs = parseOrThrow(motifTablesSchema, motifsJson, 'motifs.json');
	return cachedMotifs;
}

export function getLanguages(): NamedEntry[] {
	if (!cachedLanguages) cachedLanguages = parseOrThrow(languagesFileSchema, languagesJson, 'languages.json');
	return cachedLanguages;
}

export function getConditions(): NamedEntry[] {
	if (!cachedConditions) cachedConditions = parseOrThrow(conditionsFileSchema, conditionsJson, 'conditions.json');
	return cachedConditions;
}

export function getAfflictions(): AfflictionDefinition[] {
	if (!cachedAfflictions) cachedAfflictions = parseOrThrow(afflictionsFileSchema, afflictionsJson, 'afflictions.json');
	return cachedAfflictions;
}

export function getRules(): RuleEntry[] {
	if (!cachedRules) cachedRules = parseOrThrow(rulesFileSchema, rulesJson, 'rules.json');
	return cachedRules;
}

export function getSpells(): SpellDefinition[] {
	if (!cachedSpells) cachedSpells = parseOrThrow(spellsFileSchema, spellsJson, 'spells.json');
	return cachedSpells;
}

/** Everything the creation wizard needs, in one validated bundle. */
export function loadWizardData() {
	return {
		contentPack: getContentPack(),
		kiths: getKiths(),
		paths: getPaths(),
		talents: getTalents(),
		items: getItems(),
		motifs: getMotifs(),
		languages: getLanguages(),
		conditions: getConditions(),
		afflictions: getAfflictions()
	};
}

export type WizardData = ReturnType<typeof loadWizardData>;
