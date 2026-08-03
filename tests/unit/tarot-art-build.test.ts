import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FACE_SOURCE_MAP, BACK_COMPOSITIONS, COLLECTION } from '../../scripts/tarot-art/source-map.mjs';
import { manifestRelativePath } from '../../scripts/tarot-art/verify.mjs';
import {
	RUNTIME_MANIFEST_BASENAME,
	projectRuntimeManifest,
	serializeManifest
} from '../../scripts/tarot-art/runtime-projection.mjs';
import { tarotArtManifestSchema } from '$lib/schemas/tarot-art.schema';
import { tarotArtRuntimeManifestSchema } from '$lib/schemas/tarot-art-runtime.schema';

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
		expect(Object.keys(manifest.backs).sort()).toEqual(Object.keys(BACK_COMPOSITIONS).sort());
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

	/**
	 * The verifier's guarantee is "these committed derivatives are present and
	 * unmodified". It keeps that only if every manifest path it hashes lands
	 * inside the output root — otherwise an unrelated file's hash could stand
	 * in for a derivative that is actually missing, and the run would pass.
	 */
	describe('manifest path mapping', () => {
		const root = COLLECTION.outputDir;

		it('maps a normal variant path to a path under the output root', () => {
			expect(manifestRelativePath(`${COLLECTION.publicPathPrefix}/faces/fool-240.avif`, root)).toEqual({
				relative: 'faces/fool-240.avif',
				problem: null
			});
		});

		it('refuses a traversal that would escape the output root', () => {
			const escaped = manifestRelativePath(`${COLLECTION.publicPathPrefix}/../../favicon.svg`, root);
			expect(escaped.relative).toBeNull();
			expect(escaped.problem).toMatch(/escapes the output root/);
		});

		it('refuses a path outside the collection prefix', () => {
			const foreign = manifestRelativePath('/favicon.svg', root);
			expect(foreign.relative).toBeNull();
			expect(foreign.problem).toMatch(/outside the collection prefix/);
		});

		it('holds for every path in the committed manifest', () => {
			const manifest = loadManifest();
			let checked = 0;
			for (const asset of [...Object.values(manifest.faces), ...Object.values(manifest.backs)]) {
				for (const variant of asset.variants) {
					expect(manifestRelativePath(variant.path, root).problem).toBeNull();
					checked++;
				}
			}
			// Not vacuous: the committed collection is 80 assets x 6 variants.
			expect(checked).toBe(80 * 6);
		});

		/**
		 * End-to-end rather than helper-level: the containment check above is
		 * lexical, so it cannot see a symlink, and `walk` skips links because
		 * they are not `isFile()`. This drives the real CLI against a doctored
		 * output tree to prove the verifier itself refuses to accept a link's
		 * target in place of a derivative.
		 */
		it('the CLI refuses a symlinked derivative standing in for a real file', () => {
			const fixture = mkdtempSync(join(tmpdir(), 'tarot-verify-symlink-'));
			try {
				const outDir = join(fixture, COLLECTION.outputDir);
				mkdirSync(join(outDir, 'faces'), { recursive: true });
				const decoy = join(fixture, 'decoy.bin');
				writeFileSync(decoy, 'not a derivative');
				const bytes = readFileSync(decoy);
				const link = join(outDir, 'faces', 'fool-240.avif');
				symlinkSync(decoy, link);
				const doctored = {
					faces: {
						fool: {
							variants: [
								{
									format: 'avif',
									width: 240,
									height: 400,
									bytes: bytes.byteLength,
									sha256: createHash('sha256').update(bytes).digest('hex'),
									path: `${COLLECTION.publicPathPrefix}/faces/fool-240.avif`
								}
							]
						}
					},
					backs: {}
				};
				writeFileSync(join(outDir, 'tarot-art.json'), JSON.stringify(doctored));
				// A consistent runtime projection rides along so the symlink stays
				// this fixture's ONLY defect — the run must fail on the link, not
				// on projection drift.
				writeFileSync(
					join(outDir, RUNTIME_MANIFEST_BASENAME),
					serializeManifest(projectRuntimeManifest(doctored as never))
				);

				const result = spawnSync(
					process.execPath,
					[join(process.cwd(), 'scripts/tarot-art/verify.mjs')],
					{ cwd: fixture, encoding: 'utf8' }
				);
				// The hash and size in the manifest MATCH the link's target, so
				// only the regular-file check can reject this.
				expect(result.status).toBe(1);
				expect(result.stderr).toMatch(/not a regular file/);
				expect(result.stderr).not.toMatch(/runtime projection/);
			} finally {
				rmSync(fixture, { recursive: true, force: true });
			}
		});
	});

	/**
	 * Issue #32's contract: the app imports `tarot-art.runtime.json`, not the
	 * full manifest, so the committed projection must be provably derived from
	 * the committed manifest and must carry none of the provenance the split
	 * exists to keep out of the client bundle.
	 */
	describe('runtime projection', () => {
		const runtimeRaw = readFileSync(`${COLLECTION.outputDir}/${RUNTIME_MANIFEST_BASENAME}`, 'utf8');
		const manifestRaw = readFileSync(`${COLLECTION.outputDir}/tarot-art.json`, 'utf8');

		it('is byte-for-byte the projection of the committed manifest', () => {
			expect(runtimeRaw).toBe(serializeManifest(projectRuntimeManifest(JSON.parse(manifestRaw))));
		});

		it('parses under its strict schema, as the full manifest does under its own', () => {
			// Both schemas are .strict(): this is the drift alarm for an emitter
			// that grows a field without the schemas keeping up — and it is the
			// full schema's remaining consumer now that the app no longer parses
			// that file.
			expect(() => tarotArtManifestSchema.parse(JSON.parse(manifestRaw))).not.toThrow();
			const runtime = tarotArtRuntimeManifestSchema.parse(JSON.parse(runtimeRaw));
			expect(Object.keys(runtime.faces).sort()).toEqual(Object.keys(FACE_SOURCE_MAP).sort());
			expect(Object.keys(runtime.backs).sort()).toEqual(Object.keys(BACK_COMPOSITIONS).sort());
		});

		it('carries no build-time provenance', () => {
			for (const key of ['"sha256":', '"sourceSha256":', '"bytes":', '"source":', '"generator":', '"permissionBasis":', '"backProvenance":', '"sourceSet":']) {
				expect(runtimeRaw).not.toContain(key);
			}
		});

		it('projects only the resolver-read fields, dropping anything else', () => {
			const projected = projectRuntimeManifest({
				schemaVersion: 1,
				collectionId: 'x',
				faces: {
					fool: {
						source: 'a.png',
						sourceSha256: 'f'.repeat(64),
						width: 1086,
						height: 1810,
						surprise: 'dropped',
						variants: [
							{ format: 'avif', width: 240, height: 400, bytes: 9, sha256: 'f'.repeat(64), path: '/x/fool-240.avif', extra: 'dropped' }
						]
					}
				},
				backs: {}
			} as never);
			expect(projected.faces.fool).toEqual({
				width: 1086,
				height: 1810,
				variants: [{ format: 'avif', width: 240, height: 400, path: '/x/fool-240.avif' }]
			});
		});
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
