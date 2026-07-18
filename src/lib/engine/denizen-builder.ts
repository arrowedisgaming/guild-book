/**
 * Denizen-builder engine — pure functions for the "monstrous mixology" recipe:
 * combine a theme and a threat into a seeded stat block, then let the user
 * customize every detail. No stores, no browser APIs; unit-testable.
 */

import type {
	DenizenAbility,
	DenizenDefinition,
	DenizenPool,
	DenizenStatValue,
	DenizenThemeDefinition,
	DenizenThreatDefinition
} from '$lib/types/content-pack';

/**
 * One named pool of Health/Defense in progress (dungeon lords). Same string
 * conventions as the draft's top-level stats; `toDenizenDefinition` normalizes.
 */
export interface DenizenPoolDraft {
	name: string;
	health: string;
	defense: string;
	/** Markdown — what defeating (or wearing, or burning…) this pool means. */
	text: string;
	notes: DenizenAbility[];
	lesserDooms: DenizenAbility[];
	greaterDooms: DenizenAbility[];
}

/**
 * A denizen in progress. Stats are kept as strings so the user can type the
 * book's special values ("X", "∞") as freely as numbers; likes/hates are
 * comma-separated for easy editing. `toDenizenDefinition` normalizes.
 */
export interface DenizenDraft {
	name: string;
	/** The classic monster this starts from ("a zombie…"). */
	concept: string;
	/** The one exaggerated aspect ("…but it's animated by a swarm of locusts"). */
	exaggeration: string;
	/** Optional freeform description; falls back to concept + exaggeration. */
	flavor: string;
	themeId: string | null;
	threatId: string | null;
	/** The template pair the stats below were seeded from (re-seed on change). */
	seededFrom: { themeId: string; threatId: string } | null;
	attributes: { swords: string; pentacles: string; cups: string; wands: string };
	health: string;
	defense: string;
	/** Seeded from the threat template; editable, kept through export. */
	statNote: string;
	likes: string;
	hates: string;
	notes: DenizenAbility[];
	lesserDooms: DenizenAbility[];
	greaterDooms: DenizenAbility[];
	/**
	 * Named Health/Defense pools; only used when the threat's builderMode is
	 * 'pools'. Mutually exclusive with top-level health/defense.
	 */
	pools: DenizenPoolDraft[];
	/** Markdown — fight-changing rules that precede the pools. */
	specialRules: string;
}

export function createBlankPoolDraft(): DenizenPoolDraft {
	return {
		name: '',
		health: '',
		defense: '',
		text: '',
		notes: [],
		lesserDooms: [],
		greaterDooms: []
	};
}

export function createBlankDraft(): DenizenDraft {
	return {
		name: '',
		concept: '',
		exaggeration: '',
		flavor: '',
		themeId: null,
		threatId: null,
		seededFrom: null,
		attributes: { swords: '0', pentacles: '0', cups: '0', wands: '0' },
		health: '',
		defense: '',
		statNote: '',
		likes: '',
		hates: '',
		notes: [],
		lesserDooms: [],
		greaterDooms: [],
		pools: [],
		specialRules: ''
	};
}

/**
 * Seed a draft's stat block from a theme + threat pair: attributes and HD from
 * the threat, likes/hates from the theme, standing notes from both. Dooms are
 * NOT seeded — the templates are pick-lists ("choose 1 or 2"), so the dooms
 * step offers them for selection instead. Threats fought in pools (builderMode
 * 'pools') get no top-level HD and one blank pool to start from. Preserves
 * identity fields.
 */
export function seedFromTemplates(
	draft: DenizenDraft,
	theme: DenizenThemeDefinition,
	threat: DenizenThreatDefinition
): DenizenDraft {
	const poolsMode = threat.builderMode === 'pools';
	return {
		...draft,
		themeId: theme.id,
		threatId: threat.id,
		seededFrom: { themeId: theme.id, threatId: threat.id },
		attributes: {
			swords: String(threat.attributes?.swords ?? 0),
			pentacles: String(threat.attributes?.pentacles ?? 0),
			cups: String(threat.attributes?.cups ?? 0),
			wands: String(threat.attributes?.wands ?? 0)
		},
		health: !poolsMode && threat.health !== undefined ? String(threat.health) : '',
		defense: !poolsMode && threat.defense !== undefined ? String(threat.defense) : '',
		statNote: threat.statNote ?? '',
		likes: (theme.likes ?? []).join(', '),
		hates: (theme.hates ?? []).join(', '),
		notes: [...(theme.notes ?? []), ...(threat.notes ?? [])],
		lesserDooms: [],
		greaterDooms: [],
		pools: poolsMode ? [createBlankPoolDraft()] : [],
		specialRules: ''
	};
}

// --- pool editing helpers ----------------------------------------------------

export function addPool(draft: DenizenDraft): DenizenDraft {
	return { ...draft, pools: [...draft.pools, createBlankPoolDraft()] };
}

export function removePool(draft: DenizenDraft, index: number): DenizenDraft {
	return { ...draft, pools: draft.pools.filter((_, i) => i !== index) };
}

/** Move a pool one place up (-1) or down (+1); out-of-range moves are no-ops. */
export function movePool(draft: DenizenDraft, index: number, direction: -1 | 1): DenizenDraft {
	const target = index + direction;
	if (index < 0 || index >= draft.pools.length || target < 0 || target >= draft.pools.length) {
		return draft;
	}
	const pools = [...draft.pools];
	[pools[index], pools[target]] = [pools[target], pools[index]];
	return { ...draft, pools };
}

export function updatePool(
	draft: DenizenDraft,
	index: number,
	updater: (pool: DenizenPoolDraft) => DenizenPoolDraft
): DenizenDraft {
	return {
		...draft,
		pools: draft.pools.map((pool, i) => (i === index ? updater(pool) : pool))
	};
}

/** True when the chosen templates differ from the ones the stats came from. */
export function needsReseed(draft: DenizenDraft): boolean {
	if (!draft.themeId || !draft.threatId) return false;
	if (!draft.seededFrom) return true;
	return draft.seededFrom.themeId !== draft.themeId || draft.seededFrom.threatId !== draft.threatId;
}

function toStatValue(raw: string): DenizenStatValue {
	const trimmed = raw.trim();
	const asNumber = Number(trimmed);
	return trimmed !== '' && Number.isFinite(asNumber) ? asNumber : trimmed;
}

function splitList(raw: string): string[] {
	return raw
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

// --- persisted-draft sanitizing ----------------------------------------------

const asString = (value: unknown, fallback: string): string =>
	typeof value === 'string' ? value : fallback;

const asAbilities = (value: unknown): DenizenAbility[] =>
	Array.isArray(value)
		? value.filter(
				(a): a is DenizenAbility =>
					typeof a === 'object' &&
					a !== null &&
					typeof (a as DenizenAbility).name === 'string' &&
					typeof (a as DenizenAbility).text === 'string'
			)
		: [];

const asPoolDrafts = (value: unknown): DenizenPoolDraft[] => {
	if (!Array.isArray(value)) return [];
	return value
		.filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
		.map((pool) => {
			const blank = createBlankPoolDraft();
			return {
				name: asString(pool.name, blank.name),
				health: asString(pool.health, blank.health),
				defense: asString(pool.defense, blank.defense),
				text: asString(pool.text, blank.text),
				notes: asAbilities(pool.notes),
				lesserDooms: asAbilities(pool.lesserDooms),
				greaterDooms: asAbilities(pool.greaterDooms)
			};
		});
};

/**
 * Rebuild a DenizenDraft from untrusted data (localStorage can hold drafts
 * written by older builds or edited by hand). Every field is type-checked and
 * falls back to the blank draft's value; unknown keys are dropped.
 */
export function sanitizeDraft(raw: unknown): DenizenDraft {
	const blank = createBlankDraft();
	if (typeof raw !== 'object' || raw === null) return blank;
	const draft = raw as Record<string, unknown>;
	const attributes = (
		typeof draft.attributes === 'object' && draft.attributes !== null ? draft.attributes : {}
	) as Record<string, unknown>;
	const seeded = draft.seededFrom as { themeId?: unknown; threatId?: unknown } | null | undefined;

	return {
		name: asString(draft.name, blank.name),
		concept: asString(draft.concept, blank.concept),
		exaggeration: asString(draft.exaggeration, blank.exaggeration),
		flavor: asString(draft.flavor, blank.flavor),
		themeId: typeof draft.themeId === 'string' ? draft.themeId : null,
		threatId: typeof draft.threatId === 'string' ? draft.threatId : null,
		seededFrom:
			seeded &&
			typeof seeded === 'object' &&
			typeof seeded.themeId === 'string' &&
			typeof seeded.threatId === 'string'
				? { themeId: seeded.themeId, threatId: seeded.threatId }
				: null,
		attributes: {
			swords: asString(attributes.swords, blank.attributes.swords),
			pentacles: asString(attributes.pentacles, blank.attributes.pentacles),
			cups: asString(attributes.cups, blank.attributes.cups),
			wands: asString(attributes.wands, blank.attributes.wands)
		},
		health: asString(draft.health, blank.health),
		defense: asString(draft.defense, blank.defense),
		statNote: asString(draft.statNote, blank.statNote),
		likes: asString(draft.likes, blank.likes),
		hates: asString(draft.hates, blank.hates),
		notes: asAbilities(draft.notes),
		lesserDooms: asAbilities(draft.lesserDooms),
		greaterDooms: asAbilities(draft.greaterDooms),
		pools: asPoolDrafts(draft.pools),
		specialRules: asString(draft.specialRules, blank.specialRules)
	};
}

/** The HD-pair invariants, phrased for either the top level or a named pool. */
function hdPairWarnings(health: string, defense: string, where: string): string[] {
	// Top-level messages stand alone (capitalized); pool messages read "Pool 1: …".
	const phrase = (message: string) =>
		where === '' ? message.charAt(0).toUpperCase() + message.slice(1) : `${where}${message}`;
	const warnings: string[] = [];
	if ((health === '') !== (defense === '')) {
		warnings.push(phrase('Health and Defense are a pair — fill in both or leave both blank.'));
	}
	const healthNumber = Number(health);
	if (health !== '' && Number.isFinite(healthNumber) && healthNumber < 1) {
		warnings.push(phrase('starting Health cannot be 0 — use at least 1, or ∞ for the unkillable.'));
	}
	const defenseNumber = Number(defense);
	if (defense !== '' && Number.isFinite(defenseNumber) && defenseNumber < 0) {
		warnings.push(phrase('Defense cannot be negative (0 is fine).'));
	}
	return warnings;
}

/**
 * Book invariants the stat inputs can violate: Health starts at 1+ (the
 * bloodybones' "∞" is a string, not a number), Defense may be 0 but not
 * negative, and Health/Defense travel as a pair. Special string values
 * ("∞", "X") pass through untouched. Pass the chosen threat so pool-based
 * drafts (builderMode 'pools') get their pool invariants checked too: at
 * least one pool, each pool a complete HD pair, and no top-level HD alongside
 * pools (the schema's mutual-exclusivity rule).
 */
export function draftStatWarnings(
	draft: DenizenDraft,
	threat?: DenizenThreatDefinition | null
): string[] {
	const poolsMode = threat?.builderMode === 'pools';
	const health = draft.health.trim();
	const defense = draft.defense.trim();
	const warnings: string[] = [];

	if (poolsMode && draft.pools.length === 0) {
		warnings.push('This threat is fought in pools — add at least one pool of Health and Defense.');
	}
	if (draft.pools.length > 0 && (health !== '' || defense !== '')) {
		warnings.push(
			'Top-level Health/Defense and pools are mutually exclusive — clear the top-level pair.'
		);
	}
	if (!poolsMode || health !== '' || defense !== '') {
		warnings.push(...hdPairWarnings(health, defense, ''));
	}
	draft.pools.forEach((pool, index) => {
		const label = pool.name.trim() || `Pool ${index + 1}`;
		const poolHealth = pool.health.trim();
		const poolDefense = pool.defense.trim();
		if (poolHealth === '' && poolDefense === '') {
			warnings.push(`${label}: every pool needs both Health and Defense.`);
			return;
		}
		warnings.push(...hdPairWarnings(poolHealth, poolDefense, `${label}: `));
	});
	return warnings;
}

/** True when a pool draft carries no user input at all (the seeded blank). */
function isBlankPool(pool: DenizenPoolDraft): boolean {
	return (
		pool.name.trim() === '' &&
		pool.health.trim() === '' &&
		pool.defense.trim() === '' &&
		pool.text.trim() === '' &&
		pool.notes.length === 0 &&
		pool.lesserDooms.length === 0 &&
		pool.greaterDooms.length === 0
	);
}

function toPool(pool: DenizenPoolDraft, index: number): DenizenPool {
	return {
		id: `custom-pool-${index + 1}`,
		name: pool.name.trim() || `Pool ${index + 1}`,
		health: toStatValue(pool.health),
		defense: toStatValue(pool.defense),
		...(pool.text.trim() ? { text: pool.text.trim() } : {}),
		...(pool.notes.length > 0 ? { notes: pool.notes } : {}),
		...(pool.lesserDooms.length > 0 ? { lesserDooms: pool.lesserDooms } : {}),
		...(pool.greaterDooms.length > 0 ? { greaterDooms: pool.greaterDooms } : {})
	};
}

/** Materialize a draft into a DenizenDefinition for preview and export. */
export function toDenizenDefinition(draft: DenizenDraft): DenizenDefinition {
	const concept = draft.concept.trim();
	const exaggeration = draft.exaggeration.trim();
	const composed =
		concept && exaggeration ? `${concept} — but ${exaggeration}.` : concept || exaggeration;
	const pools = draft.pools.filter((pool) => !isBlankPool(pool)).map(toPool);

	return {
		id: 'custom-denizen',
		name: draft.name.trim() || 'Unnamed Denizen',
		theme: draft.themeId ?? '',
		threat: draft.threatId ?? '',
		flavor: draft.flavor.trim() || composed,
		attributes: {
			swords: toStatValue(draft.attributes.swords),
			pentacles: toStatValue(draft.attributes.pentacles),
			cups: toStatValue(draft.attributes.cups),
			wands: toStatValue(draft.attributes.wands)
		},
		...(draft.health.trim() !== '' ? { health: toStatValue(draft.health) } : {}),
		...(draft.defense.trim() !== '' ? { defense: toStatValue(draft.defense) } : {}),
		...(draft.statNote.trim() ? { statNote: draft.statNote.trim() } : {}),
		likes: splitList(draft.likes),
		hates: splitList(draft.hates),
		notes: draft.notes,
		lesserDooms: draft.lesserDooms,
		greaterDooms: draft.greaterDooms,
		...(draft.specialRules.trim() ? { specialRules: draft.specialRules.trim() } : {}),
		...(pools.length > 0 ? { pools } : {})
	};
}
