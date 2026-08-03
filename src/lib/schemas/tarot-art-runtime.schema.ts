import { z } from 'zod';

/** Schema for `static/tarot/rwsa/tarot-art.runtime.json` — the slim runtime
 * projection of the artwork manifest (issue #32): per-asset intrinsic
 * dimensions plus per-variant `format`/`width`/`height`/`path`, nothing else.
 * Validated once at import by `$lib/tarot/art.ts`.
 *
 * Kept in its own module, away from the full manifest's schema: this one is
 * client-bundled, and Zod schema construction is not reliably tree-shaken,
 * so sharing a file would drag the full schema back into the bundle the
 * projection exists to slim.
 *
 * Why parse at all when `tarot-art:verify` already proves the committed file
 * byte-matches the full manifest's projection: the two catch different
 * failures. Verify runs in CI and the release suite, not on every dev build;
 * the parse fails loudly at import on SHAPE drift — an emitter change or a
 * hand-edit this schema doesn't recognize. A stale-but-well-formed file is
 * invisible to any schema and is verify's job. Strict, like the full schema:
 * an unknown field is emitter drift worth failing on. */

const tarotArtRuntimeVariantSchema = z
	.object({
		format: z.enum(['avif', 'webp']),
		width: z.number().int().positive(),
		height: z.number().int().positive(),
		path: z.string().startsWith('/')
	})
	.strict();

const tarotArtRuntimeAssetSchema = z
	.object({
		width: z.number().int().positive(),
		height: z.number().int().positive(),
		variants: z.array(tarotArtRuntimeVariantSchema).length(6)
	})
	.strict();

export const tarotArtRuntimeManifestSchema = z
	.object({
		schemaVersion: z.literal(1),
		collectionId: z.string().min(1),
		faces: z.record(z.string(), tarotArtRuntimeAssetSchema),
		backs: z.record(z.string(), tarotArtRuntimeAssetSchema)
	})
	.strict();

export type TarotArtRuntimeManifest = z.infer<typeof tarotArtRuntimeManifestSchema>;
export type TarotArtRuntimeAsset = z.infer<typeof tarotArtRuntimeAssetSchema>;
