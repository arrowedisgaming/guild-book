/**
 * Denizen-builder state — a writable store persisted to localStorage, matching
 * the creation wizard's behavior (survive refresh, reset cleanly).
 */

import { writable } from 'svelte/store';
import { browser } from '$app/environment';
import { createBlankDraft, sanitizeDraft, type DenizenDraft } from '$lib/engine/denizen-builder';

const STORAGE_KEY = 'guildbook-denizen-builder';
const BUILDER_STATE_VERSION = 1;

export const BUILDER_STEPS = [
	{ id: 'concept', label: 'Concept' },
	{ id: 'theme', label: 'Theme' },
	{ id: 'threat', label: 'Threat' },
	{ id: 'customize', label: 'Customize' },
	{ id: 'dooms', label: 'Dooms' },
	{ id: 'review', label: 'Review' }
] as const;

export interface DenizenBuilderState {
	version: number;
	currentStep: number;
	draft: DenizenDraft;
}

function createInitialState(): DenizenBuilderState {
	return { version: BUILDER_STATE_VERSION, currentStep: 0, draft: createBlankDraft() };
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
		const lastStep = BUILDER_STEPS.length - 1;
		const step = typeof state.currentStep === 'number' ? state.currentStep : 0;
		return {
			version: BUILDER_STATE_VERSION,
			currentStep: Math.max(0, Math.min(Math.trunc(step), lastStep)),
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

		goToStep(step: number) {
			update((s) => ({ ...s, currentStep: step }));
		},

		reset() {
			update(() => createInitialState());
			if (browser) localStorage.removeItem(STORAGE_KEY);
		}
	};
}

export const denizenBuilder = createBuilderStore();
