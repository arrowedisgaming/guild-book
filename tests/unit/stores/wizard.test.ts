import { get } from 'svelte/store';
import { describe, expect, it } from 'vitest';
import { createBlankCharacter } from '$lib/types/character';
import * as wizardModule from '$lib/stores/wizard';
import type { WizardState } from '$lib/stores/wizard';

const { isPristineDraft, migrateWizardState } = wizardModule;
const STORAGE_KEY = 'guildbook-wizard-state';

class MemoryStorage {
	readonly values = new Map<string, string>();
	writeCount = 0;

	getItem(key: string): string | null {
		return this.values.get(key) ?? null;
	}

	setItem(key: string, value: string): void {
		this.writeCount += 1;
		this.values.set(key, value);
	}

	removeItem(key: string): void {
		this.values.delete(key);
	}
}

function storedState(overrides: Partial<WizardState> = {}): WizardState {
	return {
		version: 1,
		active: true,
		currentStep: 0,
		completedSteps: [],
		character: createBlankCharacter(),
		nonce: 0,
		...overrides
	};
}

describe('wizard state migration', () => {
	it.each([-1, 9, 1.5, Number.NaN])('rejects an impossible current step (%s)', (currentStep) => {
		expect(migrateWizardState(storedState({ version: 2, currentStep }))).toBeNull();
	});

	it('keeps only unique valid completed step indexes', () => {
		const migrated = migrateWizardState({
			...storedState({ version: 2 }),
			completedSteps: [0, 0, 3, -1, 9, 1.5, '2']
		});

		expect(migrated?.completedSteps).toEqual([0, 3]);
	});

	it('remaps v1 gear/review indices around the inserted bonds step', () => {
		const migrated = migrateWizardState(
			storedState({ currentStep: 7, completedSteps: [0, 1, 2, 3, 4, 5, 6] })
		);

		expect(migrated?.version).toBe(2);
		expect(migrated?.currentStep).toBe(8);
		expect(migrated?.completedSteps).toEqual([0, 1, 2, 3, 4, 5, 7]);
	});

	it('leaves pre-bonds v1 indices and v2 blobs untouched', () => {
		const v1 = migrateWizardState(storedState({ currentStep: 5, completedSteps: [0, 4] }));
		expect(v1?.currentStep).toBe(5);
		expect(v1?.completedSteps).toEqual([0, 4]);

		const v2 = migrateWizardState(
			storedState({ version: 2, currentStep: 6, completedSteps: [0, 6] })
		);
		expect(v2?.currentStep).toBe(6);
		expect(v2?.completedSteps).toEqual([0, 6]);
	});

	it('rejects a v1 blob whose step index exceeds the legacy layout', () => {
		expect(migrateWizardState(storedState({ currentStep: 8 }))).toBeNull();
	});

	it('refuses to reinterpret a blob from a newer state version', () => {
		expect(migrateWizardState(storedState({ version: 3, currentStep: 7 }))).toBeNull();
	});

	it('rejects blobs without a character or numeric current step', () => {
		expect(migrateWizardState(null)).toBeNull();
		expect(migrateWizardState({ currentStep: 0 })).toBeNull();
		expect(migrateWizardState({ character: {}, currentStep: '0' })).toBeNull();
	});
});

describe('isPristineDraft', () => {
	it('treats inactive and untouched active drafts as pristine', () => {
		expect(isPristineDraft(storedState({ active: false }))).toBe(true);
		expect(isPristineDraft(storedState())).toBe(true);
	});

	it('detects progress from navigation, completion, identity, kith, kin, or path', () => {
		expect(isPristineDraft(storedState({ currentStep: 1 }))).toBe(false);
		expect(isPristineDraft(storedState({ completedSteps: [0] }))).toBe(false);
		for (const character of [
			{ ...createBlankCharacter(), name: 'Mara' },
			{ ...createBlankCharacter(), kithId: 'human' },
			{ ...createBlankCharacter(), kinId: 'human-noble-house' },
			{ ...createBlankCharacter(), pathId: 'path-of-pentacles' }
		]) {
			expect(isPristineDraft(storedState({ character }))).toBe(false);
		}
	});
});

describe('wizard store persistence', () => {
	function createStore(storage: MemoryStorage) {
		const factory = (
			wizardModule as unknown as {
				createWizardStore?: (storage: MemoryStorage) => typeof wizardModule.wizard;
			}
		).createWizardStore;
		expect(factory).toBeTypeOf('function');
		return factory!(storage);
	}

	it('loads a valid persisted draft and exposes its summary and access boundary', () => {
		const storage = new MemoryStorage();
		storage.values.set(
			STORAGE_KEY,
			JSON.stringify(
				storedState({
					version: 2,
					currentStep: 3,
					completedSteps: [0, 1, 2],
					character: { ...createBlankCharacter(), name: 'Mara' }
				})
			)
		);

		const store = createStore(storage);
		expect(get(store).character.name).toBe('Mara');
		expect(store.draftSummary()).toEqual({ name: 'Mara', currentStep: 3 });
		expect(store.isStepAccessible(3)).toBe(true);
		expect(store.isStepAccessible(4)).toBe(false);
		expect(storage.writeCount).toBe(0);
	});

	it('writes a migrated valid blob back once without waiting for a user mutation', () => {
		const storage = new MemoryStorage();
		storage.values.set(
			STORAGE_KEY,
			JSON.stringify(storedState({ completedSteps: [0, 0, 99] }))
		);

		createStore(storage);

		expect(storage.writeCount).toBe(1);
		expect(JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}').completedSteps).toEqual([0]);
	});

	it('does not rewrite a current blob solely because its object keys have a different order', () => {
		const storage = new MemoryStorage();
		const current = storedState({
			version: 2,
			character: { ...createBlankCharacter(), name: 'Mara' }
		});
		storage.values.set(
			STORAGE_KEY,
			JSON.stringify({
				character: current.character,
				nonce: current.nonce,
				completedSteps: current.completedSteps,
				currentStep: current.currentStep,
				active: current.active,
				version: current.version
			})
		);

		createStore(storage);

		expect(storage.writeCount).toBe(0);
	});

	it.each(['{not json', JSON.stringify({ currentStep: 0 })])(
		'removes an invalid persisted blob and recovers to a clean inactive state',
		(raw) => {
			const storage = new MemoryStorage();
			storage.setItem(STORAGE_KEY, raw);

			const store = createStore(storage);
			expect(get(store)).toMatchObject({ active: false, currentStep: 0, completedSteps: [] });
			expect(storage.getItem(STORAGE_KEY)).toBeNull();
		}
	);

	it('leaves a newer-version blob in storage untouched and starts clean', () => {
		const storage = new MemoryStorage();
		const newer = JSON.stringify(storedState({ version: 3, currentStep: 7 }));
		storage.values.set(STORAGE_KEY, newer);

		const store = createStore(storage);
		expect(get(store)).toMatchObject({ active: false, currentStep: 0, completedSteps: [] });
		expect(storage.getItem(STORAGE_KEY)).toBe(newer);
		expect(storage.writeCount).toBe(0);
	});

	it('keeps a newer-version blob vaulted through an auto-started pristine draft', () => {
		const storage = new MemoryStorage();
		const newer = JSON.stringify(storedState({ version: 3, currentStep: 7 }));
		storage.values.set(STORAGE_KEY, newer);

		const store = createStore(storage);
		// WizardShell's deep-link guard auto-starts on any wizard route; the
		// resulting pristine draft must not overwrite the vaulted blob.
		store.start();
		expect(storage.getItem(STORAGE_KEY)).toBe(newer);
		expect(storage.writeCount).toBe(0);

		// ANY real user work may overwrite it — including fields isPristineDraft
		// does not track, like pronouns.
		store.updateCharacter((character) => ({ ...character, pronouns: 'she/her' }));
		const persisted = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}');
		expect(persisted.version).toBe(2);
		expect(persisted.character.pronouns).toBe('she/her');
	});

	it('persists mutations, deduplicates completion, and removes storage on reset', () => {
		const storage = new MemoryStorage();
		const store = createStore(storage);

		store.start();
		store.updateCharacter((character) => ({ ...character, name: 'Mara' }));
		store.completeStep(0);
		store.completeStep(0);
		expect(get(store)).toMatchObject({
			active: true,
			currentStep: 1,
			completedSteps: [0],
			nonce: 1
		});
		expect(JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}').character.name).toBe('Mara');

		store.reset();
		expect(get(store)).toMatchObject({ active: false, currentStep: 0, nonce: 2 });
		expect(storage.getItem(STORAGE_KEY)).toBeNull();
	});
});
