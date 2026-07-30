import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FACE_SOURCE_MAP, BACK_SOURCE_MAP, COLLECTION } from '../../scripts/tarot-art/source-map.mjs';

/**
 * Task 2's committed-output contract: these tests read the COMMITTED manifest
 * (and only the manifest — no ignored source, no rebuild), so they hold in CI
 * where `assets-src/` cannot exist. Derivation fidelity is `tarot-art:verify`'s
 * job, on the machine that generated the assets.
 */

interface ManifestVariant {
	format: string;
	width: number;
	height: number;
	bytes: number;
	sha256: string;
	path: string;
}

interface ManifestAsset {
	source: string;
	sourceSha256: string;
	width: number;
	height: number;
	variants: ManifestVariant[];
}

function loadManifest(): {
	schemaVersion: number;
	collectionId: string;
	faces: Record<string, ManifestAsset>;
	backs: Record<string, ManifestAsset>;
} {
	return JSON.parse(readFileSync(`${COLLECTION.outputDir}/tarot-art.json`, 'utf8'));
}

describe('tarot artwork manifest', () => {
	it('covers all 78 faces and both backs at schema version 1', () => {
		const manifest = loadManifest();
		expect(manifest.schemaVersion).toBe(1);
		expect(manifest.collectionId).toBe('rwsa');
		expect(Object.keys(manifest.faces).sort()).toEqual(Object.keys(FACE_SOURCE_MAP).sort());
		expect(Object.keys(manifest.backs).sort()).toEqual(Object.keys(BACK_SOURCE_MAP).sort());
	});

	it('records portrait sources with hashes and emits exactly six non-PNG variants each', () => {
		const manifest = loadManifest();
		for (const asset of [...Object.values(manifest.faces), ...Object.values(manifest.backs)]) {
			expect(asset.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
			expect(asset.width).toBeGreaterThan(0);
			expect(asset.height).toBeGreaterThan(asset.width);
			expect(asset.variants.map((v) => v.format).sort()).toEqual(['avif', 'avif', 'avif', 'webp', 'webp', 'webp']);
			expect(asset.variants.every((v) => !v.path.endsWith('.png'))).toBe(true);
		}
	});

	it('declares only measured variant widths that fill every tier', () => {
		// The srcset a variant feeds must not lie: each format carries exactly
		// the 240/480/960 tiers, at their real encoded widths.
		const manifest = loadManifest();
		for (const asset of [...Object.values(manifest.faces), ...Object.values(manifest.backs)]) {
			const widths = asset.variants.map((v) => v.width).sort((a, b) => a - b);
			expect(widths).toEqual([240, 240, 480, 480, 960, 960]);
			for (const variant of asset.variants) {
				expect(variant.bytes).toBeGreaterThan(0);
				expect(variant.sha256).toMatch(/^[a-f0-9]{64}$/);
				expect(variant.path.startsWith(`${COLLECTION.publicPathPrefix}/`)).toBe(true);
			}
		}
	});

	it('uses each variant path exactly once', () => {
		const manifest = loadManifest();
		const paths = [...Object.values(manifest.faces), ...Object.values(manifest.backs)].flatMap((asset) =>
			asset.variants.map((v) => v.path)
		);
		expect(new Set(paths).size).toBe(paths.length);
		expect(paths.length).toBe(80 * 6);
	});
});
