import { describe, expect, it } from 'vitest';
import { getTarotFaceSources, getTarotBackSources, hasTarotArt } from '$lib/tarot/art';
import type { TarotBackId } from '$lib/types/tarot-art';
import { FACE_SOURCE_MAP, BACK_COMPOSITIONS } from '../../scripts/tarot-art/source-map.mjs';

describe('tarot art resolver', () => {
	it('reports art as present when the manifest is committed', () => {
		expect(hasTarotArt).toBe(true);
	});

	it('resolves responsive sources for a face by stable id', () => {
		expect(getTarotFaceSources('fool')).toMatchObject({
			avifSrcset: expect.stringContaining('/tarot/rwsa/faces/fool-240.avif 240w'),
			webpSrcset: expect.stringContaining('/tarot/rwsa/faces/fool-240.webp 240w')
		});
	});

	it('resolves every mapped face id and both backs', () => {
		for (const cardId of Object.keys(FACE_SOURCE_MAP)) {
			const sources = getTarotFaceSources(cardId);
			expect(sources.avifSrcset).toContain(' 960w');
			expect(sources.webpSrcset).toContain(' 960w');
			expect(sources.fallbackWebp).toMatch(/\.webp$/);
			expect(sources.height).toBeGreaterThan(sources.width);
		}
		for (const backId of Object.keys(BACK_COMPOSITIONS) as TarotBackId[]) {
			expect(getTarotBackSources(backId).avifSrcset).toContain(`/tarot/rwsa/backs/${backId}-240.avif`);
		}
	});

	it('pins a requested tier to a single candidate in every format', () => {
		const sources = getTarotFaceSources('fool', 960);
		expect(sources.avifSrcset).toBe('/tarot/rwsa/faces/fool-960.avif 960w');
		expect(sources.webpSrcset).toBe('/tarot/rwsa/faces/fool-960.webp 960w');
		// The plain-`src` fallback follows the tier too, so a browser without
		// srcset support does not quietly drop back to 480.
		expect(sources.fallbackWebp).toBe('/tarot/rwsa/faces/fool-960.webp');
	});

	it('throws on an unknown id rather than resolving a guess', () => {
		expect(() => getTarotFaceSources('not-a-card')).toThrow(/unknown tarot art id/i);
	});
});
