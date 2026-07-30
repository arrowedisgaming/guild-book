import { describe, expect, it } from 'vitest';
import { getTarotFaceSources, getTarotBackSources, hasTarotArt } from '$lib/tarot/art';
import { FACE_SOURCE_MAP, BACK_SOURCE_MAP } from '../../scripts/tarot-art/source-map.mjs';

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
		for (const backId of Object.keys(BACK_SOURCE_MAP) as Array<'ornate' | 'plain'>) {
			expect(getTarotBackSources(backId).avifSrcset).toContain(`/tarot/rwsa/backs/${backId}-240.avif`);
		}
	});

	it('defaults the back to ornate — the back the table renders face-down', () => {
		expect(getTarotBackSources().avifSrcset).toContain('/tarot/rwsa/backs/ornate-240.avif');
	});

	it('throws on an unknown id rather than resolving a guess', () => {
		expect(() => getTarotFaceSources('not-a-card')).toThrow(/unknown tarot art id/i);
	});
});
