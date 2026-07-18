import { describe, expect, it } from 'vitest';
import { allCardIds, findZoneDescriptor } from '$lib/engine/session/state';
import { makeSessionFixture } from '../../fixtures/session';

describe('allCardIds', () => {
	it('flattens every zone\'s cards into one list covering the whole 78-card set', () => {
		const state = makeSessionFixture();
		const ids = allCardIds(state);
		expect(ids).toHaveLength(78);
		expect(new Set(ids).size).toBe(78);
		expect(ids).toEqual(expect.arrayContaining([...state.majorDraw, ...state.playerDraw]));
	});
});

describe('findZoneDescriptor', () => {
	it('resolves a fixed zone by id', () => {
		const state = makeSessionFixture();
		expect(findZoneDescriptor(state, 'majorDraw')?.cards).toBe(state.majorDraw);
	});

	it('returns undefined for an unknown zone id', () => {
		const state = makeSessionFixture();
		expect(findZoneDescriptor(state, 'nope')).toBeUndefined();
	});
});
