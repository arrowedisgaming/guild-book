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

/** The step path for a draft: 'pools' appears only for pool-based threats. */
export function builderPath(poolsMode: boolean): BuilderStep[] {
	return BUILDER_STEP_CATALOGUE.filter((s) => s.id !== 'pools' || poolsMode);
}

export interface DenizenBuilderState {
	version: number;
	currentStepId: BuilderStepId;
	draft: DenizenDraft;
}

function createInitialState(): DenizenBuilderState {
	return { version: BUILDER_STATE_VERSION, currentStepId: 'concept', draft: createBlankDraft() };
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
		return {
			version: BUILDER_STATE_VERSION,
			currentStepId: sanitizeStepId(state.currentStepId ?? state.currentStep),
			draft: sanitizeDraft(state.draft)
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

		reset() {
			update(() => createInitialState());
			if (browser) localStorage.removeItem(STORAGE_KEY);
		}
	};
}

export const denizenBuilder = createBuilderStore();
