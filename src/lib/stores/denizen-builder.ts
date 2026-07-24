/**
 * Denizen-builder state — a writable store persisted to localStorage, matching
 * the creation wizard's behavior (survive refresh, reset cleanly).
 *
 * Position is persisted by step id, not index: the step path is mode-dependent
 * (threats with builderMode 'pools' insert a Pools step), so an index would
 * point at different steps in different modes. `builderPath` derives the
 * active path; if a persisted id ever falls off the path (a mode switch
 * removed it), the page snaps to 'customize' — the step both modes share.
 */

import { writable } from 'svelte/store';
import { browser } from '$app/environment';
import { createBlankDraft, sanitizeDraft, type DenizenDraft } from '$lib/engine/denizen-builder';

const STORAGE_KEY = 'guildbook-denizen-builder';
const BUILDER_STATE_VERSION = 1;

/** Every step the builder knows, in order. Not every mode visits every step. */
export const BUILDER_STEP_CATALOGUE = [
	{ id: 'concept', label: 'Concept' },
	{ id: 'theme', label: 'Theme' },
	{ id: 'threat', label: 'Threat' },
	{ id: 'person', label: 'Person' },
	{ id: 'customize', label: 'Customize' },
	{ id: 'pools', label: 'Pools' },
	{ id: 'dooms', label: 'Dooms' },
	{ id: 'review', label: 'Review' }
] as const;

export type BuilderStep = (typeof BUILDER_STEP_CATALOGUE)[number];
export type BuilderStepId = BuilderStep['id'];

const STEP_IDS = BUILDER_STEP_CATALOGUE.map((s) => s.id) as readonly string[];

/** Version-1 states persisted a numeric index into the pre-pools step list. */
const LEGACY_STEP_IDS: readonly BuilderStepId[] = [
	'concept',
	'theme',
	'threat',
	'customize',
	'dooms',
	'review'
];

export type BuilderPathMode = 'standard' | 'pools' | 'person';

/**
 * The step path for a draft: 'pools' appears only for pool-based threats;
 * person-mode themes swap Threat for a Person step.
 */
export function builderPath(mode: BuilderPathMode): BuilderStep[] {
	return BUILDER_STEP_CATALOGUE.filter((s) => {
		if (s.id === 'pools') return mode === 'pools';
		if (s.id === 'person') return mode === 'person';
		if (s.id === 'threat') return mode !== 'person';
		return true;
	});
}

/**
 * Work parked while the draft is in the other mode: switching Man → Undead
 * stashes the person draft, and switching back restores it instead of
 * reseeding, so no work is lost crossing the mode boundary.
 */
export interface ModeStash {
	creature: DenizenDraft | null;
	person: DenizenDraft | null;
}

export interface DenizenBuilderState {
	version: number;
	currentStepId: BuilderStepId;
	draft: DenizenDraft;
	modeStash: ModeStash;
	/**
	 * Creature work parked per template pair ("themeId|threatId"): changing
	 * templates stashes the outgoing draft and restores earlier work on the
	 * newly chosen pair instead of reseeding it away.
	 */
	pairStash: Record<string, DenizenDraft>;
}

/** Belt-and-braces bound — there are only ~20 usable template pairs. */
const MAX_PAIR_STASHES = 24;

function createInitialState(): DenizenBuilderState {
	return {
		version: BUILDER_STATE_VERSION,
		currentStepId: 'concept',
		draft: createBlankDraft(),
		modeStash: { creature: null, person: null },
		pairStash: {}
	};
}

/** Accept a known step id, migrate a legacy numeric index, else start over. */
function sanitizeStepId(raw: unknown): BuilderStepId {
	if (typeof raw === 'string' && STEP_IDS.includes(raw)) return raw as BuilderStepId;
	if (typeof raw === 'number' && Number.isFinite(raw)) {
		const index = Math.max(0, Math.min(Math.trunc(raw), LEGACY_STEP_IDS.length - 1));
		return LEGACY_STEP_IDS[index];
	}
	return 'concept';
}

function loadFromStorage(): DenizenBuilderState {
	if (!browser) return createInitialState();
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return createInitialState();
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null) return createInitialState();
		const state = parsed as Record<string, unknown>;
		if (state.version !== BUILDER_STATE_VERSION) return createInitialState();
		// Stored drafts are untrusted (older builds, manual edits) — rebuild
		// field by field instead of spreading a cast object into the state.
		const stash = (state.modeStash ?? {}) as Record<string, unknown>;
		const rawPairs =
			typeof state.pairStash === 'object' && state.pairStash !== null
				? (state.pairStash as Record<string, unknown>)
				: {};
		const pairStash = Object.fromEntries(
			Object.entries(rawPairs)
				.slice(0, MAX_PAIR_STASHES)
				.map(([key, value]) => [key, sanitizeDraft(value)])
		);
		return {
			version: BUILDER_STATE_VERSION,
			currentStepId: sanitizeStepId(state.currentStepId ?? state.currentStep),
			draft: sanitizeDraft(state.draft),
			modeStash: {
				creature: stash.creature ? sanitizeDraft(stash.creature) : null,
				person: stash.person ? sanitizeDraft(stash.person) : null
			},
			pairStash
		};
	} catch {
		return createInitialState();
	}
}

function createBuilderStore() {
	const { subscribe, update } = writable<DenizenBuilderState>(loadFromStorage());

	subscribe((state) => {
		if (browser) localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	});

	return {
		subscribe,

		updateDraft(updater: (draft: DenizenDraft) => DenizenDraft) {
			update((s) => ({ ...s, draft: updater(s.draft) }));
		},

		goToStep(stepId: BuilderStepId) {
			update((s) => ({ ...s, currentStepId: stepId }));
		},

		/**
		 * Change creature templates: the outgoing draft is stashed under the
		 * pair its stats were seeded from, and `build` receives any earlier
		 * work on the newly chosen pair (consumed on restore).
		 */
		reseedPair(
			pairKey: string,
			build: (stashed: DenizenDraft | null, current: DenizenDraft) => DenizenDraft
		) {
			update((s) => {
				const pairs = { ...s.pairStash };
				const outgoingKey =
					s.draft.kind === 'creature' && s.draft.seededFrom
						? `${s.draft.seededFrom.themeId}|${s.draft.seededFrom.threatId}`
						: null;
				if (outgoingKey && Object.keys(pairs).length < MAX_PAIR_STASHES) {
					pairs[outgoingKey] = s.draft;
				}
				const stashed = pairs[pairKey] ?? null;
				delete pairs[pairKey];
				return { ...s, draft: build(stashed, s.draft), pairStash: pairs };
			});
		},

		/**
		 * Cross the creature/person mode boundary: the outgoing draft is
		 * stashed, and `build` receives any previously stashed draft for the
		 * target mode (consumed on restore) plus the current draft.
		 */
		swapMode(
			target: 'creature' | 'person',
			build: (stashed: DenizenDraft | null, current: DenizenDraft) => DenizenDraft
		) {
			update((s) => {
				const from = target === 'person' ? 'creature' : 'person';
				return {
					...s,
					draft: build(s.modeStash[target], s.draft),
					modeStash: { ...s.modeStash, [from]: s.draft, [target]: null }
				};
			});
		},

		reset() {
			update(() => createInitialState());
			if (browser) localStorage.removeItem(STORAGE_KEY);
		}
	};
}

export const denizenBuilder = createBuilderStore();
