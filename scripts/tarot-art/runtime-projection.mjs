/**
 * The slim runtime projection of the tarot artwork manifest (issue #32).
 *
 * The full manifest is a build/verification artifact: per-variant hashes and
 * byte counts, source provenance, generator identity. The app's resolver
 * (`src/lib/tarot/art.ts`) reads none of that — only paths, formats, and
 * dimensions — yet the whole file was being inlined into the client bundle.
 * This module derives the runtime file (`tarot-art.runtime.json`) that the
 * resolver imports instead.
 *
 * It is deliberately Sharp-free: `build.mjs` uses it when emitting both
 * artifacts, and `verify.mjs`'s DEFAULT mode uses it to prove the committed
 * runtime file is exactly the projection of the committed full manifest —
 * that mode must stay importable without Sharp's native binary (see the
 * lazy-import note in `verify.mjs`).
 */

/** Basename of the emitted runtime file, next to `tarot-art.json`. */
export const RUNTIME_MANIFEST_BASENAME = 'tarot-art.runtime.json';

/**
 * @typedef {{ format: string; width: number; height: number; path: string }} RuntimeVariant
 * @typedef {{ width: number; height: number; variants: RuntimeVariant[] }} RuntimeAsset
 */

/**
 * Projects one asset map down to what the resolver reads. Field order and
 * entry order are inherited from the input (the build sorts both), so the
 * projection of a given manifest is byte-deterministic once serialized.
 * @param {Record<string, import('./build.mjs').Asset>} assets
 * @returns {Record<string, RuntimeAsset>}
 */
function projectAssets(assets) {
	return Object.fromEntries(
		Object.entries(assets).map(([id, asset]) => [
			id,
			{
				width: asset.width,
				height: asset.height,
				variants: asset.variants.map(({ format, width, height, path }) => ({ format, width, height, path }))
			}
		])
	);
}

/**
 * The projection: per-asset intrinsic dimensions plus per-variant
 * `format`/`width`/`height`/`path`, under the same `faces`/`backs` ids.
 * `format` rides along even though issue #32's list was path/width/height:
 * the resolver filters by it, and deriving it from the path extension would
 * make the file name load-bearing.
 * @param {{ schemaVersion: number; collectionId: string; faces: Record<string, import('./build.mjs').Asset>; backs: Record<string, import('./build.mjs').Asset> }} manifest
 */
export function projectRuntimeManifest(manifest) {
	return {
		schemaVersion: manifest.schemaVersion,
		collectionId: manifest.collectionId,
		faces: projectAssets(manifest.faces),
		backs: projectAssets(manifest.backs)
	};
}

/**
 * The one serialization both emitted artifacts use — shared so verify's
 * byte-for-byte comparison of the committed runtime file against a fresh
 * projection can never fail on formatting alone.
 * @param {unknown} manifest
 */
export function serializeManifest(manifest) {
	return `${JSON.stringify(manifest, null, '\t')}\n`;
}
