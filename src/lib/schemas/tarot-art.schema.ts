import { z } from 'zod';

/** Schema for `static/tarot/rwsa/tarot-art.json` (issue #10 Task 2's build
 * output), validated once at import by `$lib/tarot/art.ts`. Strict: an
 * unknown field in the committed manifest is a build-script drift worth
 * failing on, not tolerating. */

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);

const tarotArtVariantSchema = z
	.object({
		format: z.enum(['avif', 'webp']),
		width: z.number().int().positive(),
		height: z.number().int().positive(),
		bytes: z.number().int().positive(),
		sha256: sha256Hex,
		path: z.string().startsWith('/')
	})
	.strict();

const tarotArtAssetSchema = z
	.object({
		source: z.string().min(1),
		sourceSha256: sha256Hex,
		width: z.number().int().positive(),
		height: z.number().int().positive(),
		variants: z.array(tarotArtVariantSchema).length(6)
	})
	.strict();

export const tarotArtManifestSchema = z
	.object({
		schemaVersion: z.literal(1),
		collectionId: z.string().min(1),
		title: z.string().min(1),
		sourceSet: z.string().min(1),
		permissionBasis: z.string().min(1),
		backMappingBasis: z.string().min(1),
		processing: z.string().min(1),
		generator: z.object({ platform: z.string(), sharp: z.string(), libvips: z.string() }).strict(),
		faces: z.record(z.string(), tarotArtAssetSchema),
		backs: z.record(z.string(), tarotArtAssetSchema)
	})
	.strict();

export type TarotArtManifest = z.infer<typeof tarotArtManifestSchema>;
export type TarotArtAsset = z.infer<typeof tarotArtAssetSchema>;
