/**
 * Store-level tests for the builder's saved-row bookkeeping: loading a row
 * for editing, detaching from it, and — the regression that matters — that
 * "start fresh" paths never leave a stale editing ref or stash behind to
 * overwrite a saved denizen or resurrect abandoned work.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { denizenBuilder } from '$lib/stores/denizen-builder';
import { createBlankDraft, type DenizenDraft } from '$lib/engine/denizen-builder';

const seededCreature = (name: string, themeId: string, threatId: string): DenizenDraft => ({
	...createBlankDraft(),
	kind: 'creature',
	name,
	themeId,
	threatId,
	seededFrom: { themeId, threatId }
});

beforeEach(() => denizenBuilder.reset());

describe('denizenBuilder saved-row bookkeeping', () => {
	it('loadForEditing binds the row and clears every stash', () => {
		denizenBuilder.swapMode('person', (_stashed, current) => ({ ...current, kind: 'person' }));
		denizenBuilder.loadForEditing(seededCreature('Skeleton Lord', 'undead', 'brute'), 'row-1', 3);

		const s = get(denizenBuilder);
		expect(s.editingId).toBe('row-1');
		expect(s.editingVersion).toBe(3);
		expect(s.draft.name).toBe('Skeleton Lord');
		expect(s.modeStash).toEqual({ creature: null, person: null });
		expect(s.pairStash).toEqual({});
		expect(s.currentStepId).toBe('review');
	});

	it('detachSavedRef unbinds the row but keeps the work', () => {
		denizenBuilder.loadForEditing(seededCreature('Skeleton Lord', 'undead', 'brute'), 'row-1', 3);
		denizenBuilder.detachSavedRef();

		const s = get(denizenBuilder);
		expect(s.editingId).toBeNull();
		expect(s.editingVersion).toBeNull();
		expect(s.draft.name).toBe('Skeleton Lord');
	});

	it('setSavedRef records the row a save just created or bumped', () => {
		denizenBuilder.setSavedRef('row-9', 4);
		const s = get(denizenBuilder);
		expect(s.editingId).toBe('row-9');
		expect(s.editingVersion).toBe(4);
	});

	it('startFrom is a fresh context: no editing ref, no mode stash, no pair stash', () => {
		// Bind to a saved row and leave work in both stashes.
		denizenBuilder.loadForEditing(seededCreature('Skeleton Lord', 'undead', 'brute'), 'row-1', 3);
		denizenBuilder.reseedPair('undead|minion', (_stashed, current) => ({
			...current,
			seededFrom: { themeId: 'undead', threatId: 'minion' }
		}));
		denizenBuilder.swapMode('person', (_stashed, current) => ({ ...current, kind: 'person' }));
		expect(Object.keys(get(denizenBuilder).pairStash)).not.toHaveLength(0);

		denizenBuilder.startFrom(seededCreature('Fresh Vampire', 'undead', 'dungeon-lord'));

		const s = get(denizenBuilder);
		expect(s.editingId).toBeNull();
		expect(s.editingVersion).toBeNull();
		expect(s.modeStash).toEqual({ creature: null, person: null });
		// Regression: a leftover pair stash would silently replace the
		// pre-filled bestiary copy on the next template switch.
		expect(s.pairStash).toEqual({});
		expect(s.draft.name).toBe('Fresh Vampire');
	});
});
