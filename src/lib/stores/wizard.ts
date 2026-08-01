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

export interface WizardStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

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
	if (
		!Number.isInteger(candidate.currentStep) ||
		candidate.currentStep < 0 ||
		candidate.currentStep >= WIZARD_STEPS.length
	) {
		return null;
	}
	const completedSteps = Array.isArray(candidate.completedSteps)
		? [
				...new Set(
					candidate.completedSteps.filter(
						(step): step is number =>
							typeof step === 'number' &&
							Number.isInteger(step) &&
							step >= 0 &&
							step < WIZARD_STEPS.length
					)
				)
			]
		: [];

	return {
		version: WIZARD_STATE_VERSION,
		active: candidate.active === true,
		currentStep: candidate.currentStep,
		completedSteps,
		character: migrateCharacterData(candidate.character),
		nonce: typeof candidate.nonce === 'number' ? candidate.nonce : 0
	};
}

interface LoadedWizardState {
	state: WizardState;
	persistMigration: boolean;
}

function loadFromStorage(storage: WizardStorage | null): LoadedWizardState {
	if (!storage) return { state: createInitialState(), persistMigration: false };
	try {
		const raw = storage.getItem(STORAGE_KEY);
		if (!raw) return { state: createInitialState(), persistMigration: false };

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			storage.removeItem(STORAGE_KEY);
			return { state: createInitialState(), persistMigration: false };
		}

		const migrated = migrateWizardState(parsed);
		if (!migrated) {
			storage.removeItem(STORAGE_KEY);
			return { state: createInitialState(), persistMigration: false };
		}
		return {
			state: migrated,
			persistMigration: canonicalStorageJson(parsed) !== canonicalStorageJson(migrated)
		};
	} catch {
		return { state: createInitialState(), persistMigration: false };
	}
}

function canonicalStorageJson(value: unknown): string {
	return JSON.stringify(sortJsonKeys(value));
}

function sortJsonKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJsonKeys);
	if (!value || typeof value !== 'object') return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, nested]) => [key, sortJsonKeys(nested)])
	);
}

function saveToStorage(storage: WizardStorage | null, state: WizardState): void {
	if (!storage) return;
	storage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function defaultWizardStorage(): WizardStorage | null {
	return browser ? localStorage : null;
}

export function createWizardStore(storage: WizardStorage | null = defaultWizardStorage()) {
	const loaded = loadFromStorage(storage);
	if (loaded.persistMigration) saveToStorage(storage, loaded.state);
	const { subscribe, update } = writable<WizardState>(loaded.state);

	// A readable subscription fires immediately. Do not rewrite an absent or
	// invalid blob merely by importing this module; persist only real mutations.
	let initialized = false;
	subscribe((state) => {
		if (initialized) saveToStorage(storage, state);
	});
	initialized = true;

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
			storage?.removeItem(STORAGE_KEY);
		}
	};
}

export const wizard = createWizardStore();
