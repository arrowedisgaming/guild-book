/**
 * Denizen-builder engine — pure functions for the "monstrous mixology" recipe:
 * combine a theme and a threat into a seeded stat block, then let the user
 * customize every detail. No stores, no browser APIs; unit-testable.
 */

import type {
	DenizenAbility,
	DenizenDefinition,
	DenizenStatValue,
	DenizenThemeDefinition,
	DenizenThreatDefinition
} from '$lib/types/content-pack';

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
		greaterDooms: []
	};
}

/**
 * Seed a draft's stat block from a theme + threat pair: attributes and HD from
 * the threat, likes/hates from the theme, standing notes from both. Dooms are
 * NOT seeded — the templates are pick-lists ("choose 1 or 2"), so the dooms
 * step offers them for selection instead. Preserves identity fields.
 */
export function seedFromTemplates(
	draft: DenizenDraft,
	theme: DenizenThemeDefinition,
	threat: DenizenThreatDefinition
): DenizenDraft {
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
		health: threat.health !== undefined ? String(threat.health) : '',
		defense: threat.defense !== undefined ? String(threat.defense) : '',
		statNote: threat.statNote ?? '',
		likes: (theme.likes ?? []).join(', '),
		hates: (theme.hates ?? []).join(', '),
		notes: [...(theme.notes ?? []), ...(threat.notes ?? [])],
		lesserDooms: [],
		greaterDooms: []
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

/**
 * Book invariants the stat inputs can violate: Health starts at 1+ (the
 * bloodybones' "∞" is a string, not a number), Defense may be 0 but not
 * negative, and Health/Defense travel as a pair. Special string values
 * ("∞", "X") pass through untouched.
 */
export function draftStatWarnings(draft: DenizenDraft): string[] {
	const warnings: string[] = [];
	const health = draft.health.trim();
	const defense = draft.defense.trim();

	if ((health === '') !== (defense === '')) {
		warnings.push('Health and Defense are a pair — fill in both or leave both blank.');
	}
	const healthNumber = Number(health);
	if (health !== '' && Number.isFinite(healthNumber) && healthNumber < 1) {
		warnings.push('Starting Health cannot be 0 — use at least 1, or ∞ for the unkillable.');
	}
	const defenseNumber = Number(defense);
	if (defense !== '' && Number.isFinite(defenseNumber) && defenseNumber < 0) {
		warnings.push('Defense cannot be negative (0 is fine).');
	}
	return warnings;
}

/** Materialize a draft into a DenizenDefinition for preview and export. */
export function toDenizenDefinition(draft: DenizenDraft): DenizenDefinition {
	const concept = draft.concept.trim();
	const exaggeration = draft.exaggeration.trim();
	const composed =
		concept && exaggeration ? `${concept} — but ${exaggeration}.` : concept || exaggeration;

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
		greaterDooms: draft.greaterDooms
	};
}
