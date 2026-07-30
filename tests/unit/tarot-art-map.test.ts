import { describe, expect, it } from 'vitest';
import { FACE_SOURCE_MAP, BACK_SOURCE_MAP } from '../../scripts/tarot-art/source-map.mjs';
import { buildPlayerDeck, buildMajorDeck } from '$lib/engine/tarot-deck';
import { getContentPack } from '$lib/server/content/loader';

describe('RWS artwork map', () => {
	it('maps every stable card id exactly once', () => {
		const config = getContentPack().tarot;
		const expected = [...buildPlayerDeck(config), ...buildMajorDeck(config)].map((card) => card.id).sort();
		const actual = Object.keys(FACE_SOURCE_MAP).sort();
		expect(actual).toEqual(expected);
		expect(new Set(Object.values(FACE_SOURCE_MAP)).size).toBe(78);
	});

	it('maps exactly two distinct backs', () => {
		expect(Object.keys(BACK_SOURCE_MAP).sort()).toEqual(['ornate', 'plain']);
		expect(new Set(Object.values(BACK_SOURCE_MAP)).size).toBe(2);
	});
});
