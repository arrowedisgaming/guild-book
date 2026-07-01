/**
 * Creation-wizard state — a writable store persisted to localStorage across
 * navigations. Adapted from Miskatonic University Registrar's wizard store.
 */

import { writable, get } from 'svelte/store';
import { browser } from '$app/environment';
import { createBlankCharacter, type GuildBookCharacterData } from '$lib/types/character';
import { migrateCharacterData } from '$lib/engine/character-migration';

const STORAGE_KEY = 'guildbook-wizard-state';
const WIZARD_STATE_VERSION = 1;

export interface WizardState {
	version: number;
	active: boolean;
	currentStep: number;
	completedSteps: number[];
	character: GuildBookCharacterData;
	/**
	 * Monotonic counter bumped on every reset()/start(). WizardShell keys its
	 * step `{#key}` on this so +page components remount and re-init their local
	 * $state after a reset — navigating /path → /path is otherwise a no-op.
	 */
	nonce: number;
}

export interface WizardDraftSummary {
	name: string;
	currentStep: number;
}

function createInitialState(): WizardState {
	return {
		version: WIZARD_STATE_VERSION,
		active: false,
		currentStep: 0,
		completedSteps: [],
		character: createBlankCharacter(),
		nonce: 0
	};
}

function createFreshActiveState(prevNonce: number): WizardState {
	const state = createInitialState();
	state.active = true;
	state.nonce = prevNonce + 1;
	return state;
}

/** A pristine draft is a freshly-started wizard the user hasn't touched yet. */
export function isPristineDraft(state: WizardState): boolean {
	if (!state.active) return true;
	if (state.currentStep > 0) return false;
	if (state.completedSteps.length > 0) return false;
	const c = state.character;
	return !c.name.trim() && !c.kithId && !c.kinId && !c.pathId;
}

/** Promote a stored wizard blob to the current version, or discard (null). */
export function migrateWizardState(parsed: unknown): WizardState | null {
	if (!parsed || typeof parsed !== 'object') return null;
	const candidate = parsed as Partial<WizardState>;
	if (!candidate.character || typeof candidate.character !== 'object') return null;
	if (typeof candidate.currentStep !== 'number') return null;

	return {
		version: WIZARD_STATE_VERSION,
		active: candidate.active === true,
		currentStep: candidate.currentStep,
		completedSteps: Array.isArray(candidate.completedSteps) ? candidate.completedSteps : [],
		character: migrateCharacterData(candidate.character),
		nonce: typeof candidate.nonce === 'number' ? candidate.nonce : 0
	};
}

function loadFromStorage(): WizardState {
	if (!browser) return createInitialState();
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return createInitialState();

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			localStorage.removeItem(STORAGE_KEY);
			return createInitialState();
		}

		const migrated = migrateWizardState(parsed);
		if (!migrated) {
			localStorage.removeItem(STORAGE_KEY);
			return createInitialState();
		}
		return migrated;
	} catch {
		return createInitialState();
	}
}

function saveToStorage(state: WizardState): void {
	if (!browser) return;
	localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function createWizardStore() {
	const { subscribe, update } = writable<WizardState>(loadFromStorage());

	subscribe((state) => saveToStorage(state));

	return {
		subscribe,

		/** Start a new adventurer. */
		start() {
			update((s) => createFreshActiveState(s.nonce ?? 0));
		},

		/** Mutate the character in-flight. */
		updateCharacter(updater: (char: GuildBookCharacterData) => GuildBookCharacterData) {
			update((s) => ({ ...s, character: updater(s.character) }));
		},

		/** Mark a step complete and advance. */
		completeStep(stepIndex: number) {
			update((s) => {
				const completed = s.completedSteps.includes(stepIndex)
					? s.completedSteps
					: [...s.completedSteps, stepIndex];
				return { ...s, completedSteps: completed, currentStep: Math.max(s.currentStep, stepIndex + 1) };
			});
		},

		/** Jump directly to a step. */
		goToStep(stepIndex: number) {
			update((s) => ({ ...s, currentStep: stepIndex }));
		},

		isStepAccessible(stepIndex: number): boolean {
			const state = get({ subscribe });
			return stepIndex <= state.currentStep || state.completedSteps.includes(stepIndex);
		},

		hasInProgressDraft(): boolean {
			const state = get({ subscribe });
			return state.active && !isPristineDraft(state);
		},

		draftSummary(): WizardDraftSummary {
			const state = get({ subscribe });
			return {
				name: state.character.name?.trim() || 'Unnamed Adventurer',
				currentStep: state.currentStep
			};
		},

		reset() {
			update((s) => {
				const state = createInitialState();
				state.nonce = (s.nonce ?? 0) + 1;
				return state;
			});
			if (browser) localStorage.removeItem(STORAGE_KEY);
		}
	};
}

export const wizard = createWizardStore();

/** Wizard steps. Path precedes Attributes because the 4 locks to the path suit. */
export const WIZARD_STEPS = [
	{ id: 'identity', label: 'Identity', path: '/create/hmtw/identity' },
	{ id: 'kith', label: 'Kith & Kin', path: '/create/hmtw/kith' },
	{ id: 'path', label: 'Path', path: '/create/hmtw/path' },
	{ id: 'attributes', label: 'Attributes', path: '/create/hmtw/attributes' },
	{ id: 'talents', label: 'Talents', path: '/create/hmtw/talents' },
	{ id: 'story', label: 'Quest & Motifs', path: '/create/hmtw/story' },
	{ id: 'equipment', label: 'Gear', path: '/create/hmtw/equipment' },
	{ id: 'review', label: 'Review', path: '/create/hmtw/review' }
] as const;
