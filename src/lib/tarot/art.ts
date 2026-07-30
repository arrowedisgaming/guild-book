/**
 * Typed runtime artwork resolver (issue #10 Task 3).
 *
 * Amendment 4 requires the app to keep working — glyph rendering — in any
 * environment without built artwork, so the manifest CANNOT be a bare static
 * import: importing an absent file is a build error. Instead this uses the
 * same mechanism `src/hooks.server.ts` established for the possibly-absent
 * dev-auto-login module: `import.meta.glob`, whose match map is simply empty
 * when the file does not exist. Components switch on `hasTarotArt`.
 *
 * Vite requires the glob pattern to be a string literal, so this is the one
 * place the collection's output path cannot read from `source-map.mjs`'s
 * `COLLECTION` constant (Amendment 3) — if the collection is ever swapped,
 * this literal changes with it.
 *
 * The resolver accepts an already *authorized* face id: it has no session
 * state and no visibility logic. Privacy lives in the caller — a hidden card
 * must never reach the point of calling `getTarotFaceSources` at all
 * (Task 4). When art is absent, both resolvers throw; callers must check
 * `hasTarotArt` first.
 */

import { tarotArtManifestSchema, type TarotArtAsset, type TarotArtManifest } from '$lib/schemas/tarot-art.schema';
import type { TarotBackId, TarotImageSources } from '$lib/types/tarot-art';

const manifestModules = import.meta.glob<{ default: unknown }>('../../../static/tarot/rwsa/tarot-art.json', {
	eager: true
});

const manifestModule = Object.values(manifestModules)[0];

/** Parsed once at import; an invalid COMMITTED manifest fails loudly here
 * rather than resolving garbage per card. */
const manifest: TarotArtManifest | null = manifestModule
	? tarotArtManifestSchema.parse(manifestModule.default)
	: null;

/** True when the built artwork manifest is present — the Amendment 4 switch
 * between image rendering and the glyph fallback. */
export const hasTarotArt = manifest !== null;

function toSources(asset: TarotArtAsset): TarotImageSources {
	const byFormat = (format: 'avif' | 'webp') =>
		asset.variants
			.filter((variant) => variant.format === format)
			.sort((a, b) => a.width - b.width);
	const webp = byFormat('webp');
	const fallback = webp.find((variant) => variant.width === 480) ?? webp[webp.length - 1];
	return {
		avifSrcset: byFormat('avif')
			.map((variant) => `${variant.path} ${variant.width}w`)
			.join(', '),
		webpSrcset: webp.map((variant) => `${variant.path} ${variant.width}w`).join(', '),
		fallbackWebp: fallback.path,
		width: asset.width,
		height: asset.height
	};
}

export function getTarotFaceSources(cardId: string): TarotImageSources {
	const asset = manifest?.faces[cardId];
	if (!asset) throw new Error(`unknown tarot art id: ${cardId}`);
	return toSources(asset);
}

/** No default: with theme-selected backs there is no single right answer,
 * so callers name the treatment they are rendering. */
export function getTarotBackSources(backId: TarotBackId): TarotImageSources {
	const asset = manifest?.backs[backId];
	if (!asset) throw new Error(`unknown tarot art id: ${backId}`);
	return toSources(asset);
}
