/**
 * Task 2: deterministic responsive tarot artwork build (issue #10).
 *
 * Reads the ignored source scans, validates the inventory strictly against
 * `source-map.mjs` (missing, duplicate, unexpected, or case-mismatched
 * basenames fail the build), and emits uncropped 240/480/960 AVIF+WebP
 * derivatives plus a hash/dimension/licence manifest.
 *
 * Determinism: no timestamps, sorted keys, sorted variants. Output bytes are
 * deterministic for a given Sharp/libvips build on one platform; they are NOT
 * guaranteed bit-identical across platforms, which is why the manifest
 * records its `generator` and why CI verification checks committed files
 * against the committed manifest rather than re-deriving (Amendment 2).
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import sharp from 'sharp';
import { BACK_COMPOSITIONS, BACK_LOGO_FILE, COLLECTION, FACE_SOURCE_MAP, KNOWN_UNUSED_SOURCES } from './source-map.mjs';

const TIERS = Object.freeze([240, 480, 960]);
const FORMATS = Object.freeze(/** @type {const} */ (['avif', 'webp']));

/** @typedef {{ format: string; width: number; height: number; bytes: number; sha256: string; path: string }} Variant */
/** @typedef {{ source: string; sourceSha256: string; width: number; height: number; variants: Variant[] }} Asset */

/** @param {Buffer | Uint8Array} data */
function sha256(data) {
	return createHash('sha256').update(data).digest('hex');
}

/**
 * Strict inventory check: the exact 80 mapped basenames, nothing else.
 * Case differences surface as one missing + one unexpected name, which is
 * the loud failure the plan requires. Non-PNG entries (e.g. `.DS_Store`)
 * are ignored.
 * @param {string} sourceDir
 */
async function validateInventory(sourceDir) {
	const expected = [...Object.values(FACE_SOURCE_MAP), ...KNOWN_UNUSED_SOURCES].sort();
	const actual = (await readdir(sourceDir)).filter((name) => name.toLowerCase().endsWith('.png')).sort();
	const missing = expected.filter((name) => !actual.includes(name));
	const unexpected = actual.filter((name) => !expected.includes(name));
	if (missing.length > 0 || unexpected.length > 0) {
		console.error(`source inventory mismatch in ${sourceDir}`);
		for (const name of missing) console.error(`  missing:    ${name}`);
		for (const name of unexpected) console.error(`  unexpected: ${name}`);
		process.exit(1);
	}
}

/** Card dimensions every asset conforms to — the RWSa scans' exact 3:5. */
const CARD_WIDTH = 1086;
const CARD_HEIGHT = 1810;

/**
 * Composes one themed Adherent back: the committed logo centered on a flat
 * field at the card ratio. With `ink` set, the logo's linework is recolored
 * through its alpha channel (the source linework is black). Deterministic
 * for a given Sharp build, like every other emission in this script.
 * @param {Buffer} logo
 * @param {{ field: { r: number; g: number; b: number }; ink: { r: number; g: number; b: number } | null }} composition
 * @returns {Promise<Buffer>}
 */
async function composeBack(logo, composition) {
	const LOGO_WIDTH = 830;
	const resized = await sharp(logo, { failOn: 'error' }).resize({ width: LOGO_WIDTH }).png().toBuffer();
	const meta = await sharp(resized).metadata();
	let mark = resized;
	if (composition.ink) {
		const alpha = await sharp(resized).ensureAlpha().extractChannel(3).toBuffer();
		mark = await sharp({
			create: { width: meta.width ?? LOGO_WIDTH, height: meta.height ?? LOGO_WIDTH, channels: 3, background: composition.ink }
		})
			.joinChannel(alpha)
			.png()
			.toBuffer();
	}
	return sharp({ create: { width: CARD_WIDTH, height: CARD_HEIGHT, channels: 3, background: composition.field } })
		.composite([
			{
				input: mark,
				top: Math.round((CARD_HEIGHT - (meta.height ?? 0)) / 2),
				left: Math.round((CARD_WIDTH - LOGO_WIDTH) / 2)
			}
		])
		.png()
		.toBuffer();
}

/**
 * Builds one input image's six variants under `outputRoot` and returns its
 * manifest entry. Fails loudly if the input is not portrait, is animated/
 * multi-page, or cannot fill the largest tier at full measured width — a
 * `960w` srcset entry must never lie.
 * @param {Buffer} input image bytes (a face scan, or a composed back)
 * @param {string} outputRoot
 * @param {string} kind faces | backs
 * @param {string} id stable card/back id
 * @param {string} source provenance label recorded in the manifest
 * @param {string} sourceSha256 hash of the named source file
 * @returns {Promise<Asset>}
 */
async function buildAsset(input, outputRoot, kind, id, source, sourceSha256) {
	const filename = source;
	const metadata = await sharp(input, { failOn: 'error' }).metadata();
	if ((metadata.pages ?? 1) > 1) throw new Error(`${filename}: animated/multi-page input rejected`);
	const width = metadata.width ?? 0;
	const height = metadata.height ?? 0;
	if (width <= 0 || height <= width) throw new Error(`${filename}: not portrait (${width}x${height})`);
	if (width < TIERS[TIERS.length - 1]) {
		throw new Error(`${filename}: source width ${width} cannot fill the ${TIERS[TIERS.length - 1]} tier`);
	}

	/** @type {Variant[]} */
	const variants = [];
	for (const format of FORMATS) {
		for (const tier of TIERS) {
			const pipeline = sharp(input, { failOn: 'error' })
				.rotate()
				.resize({ width: tier, fit: 'inside', withoutEnlargement: true });
			const encoded =
				format === 'avif'
					? await pipeline.avif({ quality: 62, effort: 6 }).toBuffer()
					: await pipeline.webp({ quality: 82, effort: 6 }).toBuffer();
			const encodedMeta = await sharp(encoded).metadata();
			if (encodedMeta.width !== tier) {
				throw new Error(`${filename}: ${format} tier ${tier} encoded at ${encodedMeta.width} — srcset would lie`);
			}
			const basename = `${id}-${tier}.${format}`;
			const outDir = path.join(outputRoot, kind);
			await mkdir(outDir, { recursive: true });
			await writeFile(path.join(outDir, basename), encoded);
			variants.push({
				format,
				width: encodedMeta.width ?? tier,
				height: encodedMeta.height ?? 0,
				bytes: encoded.byteLength,
				sha256: sha256(encoded),
				path: `${COLLECTION.publicPathPrefix}/${kind}/${basename}`
			});
		}
	}
	variants.sort((a, b) => (a.format === b.format ? a.width - b.width : a.format.localeCompare(b.format)));
	return { source: filename, sourceSha256, width, height, variants };
}

/** @param {Record<string, unknown>} object */
function sortedShallow(object) {
	return Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Builds every derivative under `outputRoot` and returns the manifest object.
 * Exported so `verify.mjs` can rebuild to a temporary directory and compare.
 * @param {{ outputRoot?: string; concurrency?: number }} [options]
 */
export async function buildCollection({ outputRoot = COLLECTION.outputDir, concurrency = Math.max(1, cpus().length - 1) } = {}) {
	const sourceDir = COLLECTION.sourceDir;
	await validateInventory(sourceDir);

	const logoPath = path.join(path.dirname(fileURLToPath(import.meta.url)), BACK_LOGO_FILE);
	const logo = await readFile(logoPath);
	const logoSha = sha256(logo);

	/** @type {Array<{ kind: string; id: string; input: () => Promise<{ input: Buffer; source: string; sourceSha256: string }> }>} */
	const jobs = [
		...Object.entries(FACE_SOURCE_MAP).map(([id, filename]) => ({
			kind: 'faces',
			id,
			input: async () => {
				const input = await readFile(path.join(sourceDir, filename));
				return { input, source: filename, sourceSha256: sha256(input) };
			}
		})),
		...Object.entries(BACK_COMPOSITIONS).map(([id, composition]) => ({
			kind: 'backs',
			id,
			input: async () => ({
				input: await composeBack(logo, composition),
				source: BACK_LOGO_FILE,
				sourceSha256: logoSha
			})
		}))
	];

	/** @type {Record<string, Asset>} */
	const faces = {};
	/** @type {Record<string, Asset>} */
	const backs = {};
	let next = 0;
	async function worker() {
		while (next < jobs.length) {
			const job = jobs[next++];
			const { input, source, sourceSha256 } = await job.input();
			const asset = await buildAsset(input, outputRoot, job.kind, job.id, source, sourceSha256);
			if (job.kind === 'faces') faces[job.id] = asset;
			else backs[job.id] = asset;
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));

	const manifest = {
		schemaVersion: 1,
		collectionId: COLLECTION.id,
		title: COLLECTION.title,
		sourceSet: 'Locally supplied authorized 80-image set',
		permissionBasis: 'Project owner confirmed permission for this set',
		backProvenance:
			'Both backs composed at build time from the committed Adherent of the Worm third-party logo (per the maintainer decision on issue #10 replacing the scanned backs); the template’s terms state the logo is "allowed and encouraged" for third-party works',
		processing: 'Uncropped responsive AVIF/WebP derivatives',
		generator: {
			platform: `${process.platform}-${process.arch}`,
			sharp: sharp.versions?.sharp ?? 'unknown',
			libvips: sharp.versions?.vips ?? 'unknown'
		},
		faces: sortedShallow(faces),
		backs: sortedShallow(backs)
	};
	await mkdir(outputRoot, { recursive: true });
	await writeFile(path.join(outputRoot, 'tarot-art.json'), `${JSON.stringify(manifest, null, '\t')}\n`);
	return manifest;
}

// `fileURLToPath`, not `new URL(...).pathname`: the pathname is
// percent-encoded, so a space anywhere in the checkout path would make this
// comparison fail and turn the CLI into a silent exit-0 no-op.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	buildCollection()
		.then((manifest) => {
			const assets = [...Object.values(manifest.faces), ...Object.values(manifest.backs)];
			const files = assets.reduce((n, a) => n + a.variants.length, 0);
			const bytes = assets.reduce((n, a) => n + a.variants.reduce((m, v) => m + v.bytes, 0), 0);
			console.log(`tarot-art: ${assets.length} assets, ${files} derivative files, ${(bytes / 1024 / 1024).toFixed(1)} MiB + manifest`);
		})
		.catch((error) => {
			console.error(error instanceof Error ? error.message : error);
			process.exit(1);
		});
}
