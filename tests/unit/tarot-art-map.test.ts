import { describe, expect, it } from 'vitest';
import { FACE_SOURCE_MAP, BACK_COMPOSITIONS, KNOWN_UNUSED_SOURCES } from '../../scripts/tarot-art/source-map.mjs';
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

	it('composes exactly two theme backs, and the dark one has recolored ink', () => {
		expect(Object.keys(BACK_COMPOSITIONS).sort()).toEqual(['adherent-dark', 'adherent-parchment']);
		expect(BACK_COMPOSITIONS['adherent-parchment'].ink).toBeNull();
		expect(BACK_COMPOSITIONS['adherent-dark'].ink).not.toBeNull();
	});

	it('accounts for the two unmapped scanned backs the fetch script still downloads', () => {
		expect(KNOWN_UNUSED_SOURCES).toHaveLength(2);
		const mapped = new Set(Object.values(FACE_SOURCE_MAP));
		for (const unused of KNOWN_UNUSED_SOURCES) {
			expect(mapped.has(unused)).toBe(false);
		}
	});
});
