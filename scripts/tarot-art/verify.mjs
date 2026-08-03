/**
 * Verification of the committed tarot artwork (issue #10, per the
 * maintainer's amendment in the issue thread replacing Task 2 Step 6).
 *
 * Default mode needs NO ignored sources and no Sharp (the build module is
 * imported lazily, only by `--from-source`), so it runs anywhere — including
 * the clean-install release suite and the CI check job: it proves the
 * committed output matches the committed manifest. Checks:
 *   1. every variant the manifest lists exists with matching SHA-256 and size;
 *   2. the output directory contains exactly the manifest's files plus the
 *      manifest itself and its runtime projection — no strays;
 *   3. no PNG anywhere in the committed output;
 *   4. the committed runtime projection (`tarot-art.runtime.json`, the file
 *      the app imports — issue #32) is byte-for-byte the projection of the
 *      committed full manifest, so the two artifacts cannot disagree.
 *
 * `--from-source` additionally rebuilds everything from the ignored sources
 * into a temporary directory and compares — a local convenience proving
 * derivation fidelity. It is MACHINE-SPECIFIC: AVIF/WebP output is only
 * bit-stable for the same Sharp/libvips build (see the manifest's
 * `generator`), so a mismatch on a different platform means "different
 * encoder", not corruption. The hash check above is the cross-machine
 * guarantee.
 */

import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { COLLECTION } from './source-map.mjs';
import { RUNTIME_MANIFEST_BASENAME, projectRuntimeManifest, serializeManifest } from './runtime-projection.mjs';

/** @param {Buffer | Uint8Array} data */
function sha256(data) {
	return createHash('sha256').update(data).digest('hex');
}

/**
 * @param {string} dir
 * @returns {Promise<string[]>} relative paths of all files under `dir`
 */
async function walk(dir) {
	const out = [];
	for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
		if (entry.isFile()) {
			out.push(path.relative(dir, path.join(entry.parentPath, entry.name)));
		}
	}
	return out.sort();
}

/**
 * Maps a manifest variant's public URL back to a path under the output root,
 * refusing anything that does not land inside it.
 *
 * Both checks matter. Stripping the prefix alone leaves `..` segments intact,
 * so `/tarot/rwsa/../../favicon.svg` would resolve to a file outside the
 * artwork tree — and since verification is "hash the file this path names",
 * an unrelated file's hash could stand in for a derivative that is actually
 * missing, and the run would pass. The verifier's whole claim is that the
 * committed derivatives are present and unmodified, so a path it cannot place
 * inside the output root is a failure, not something to resolve leniently.
 *
 * @param {string} variantPath public URL from the manifest
 * @param {string} root output root the derivatives live under
 * @returns {{ relative: string; problem: null } | { relative: null; problem: string }}
 */
export function manifestRelativePath(variantPath, root) {
	const prefix = `${COLLECTION.publicPathPrefix}/`;
	if (!variantPath.startsWith(prefix)) {
		return { relative: null, problem: `manifest path outside the collection prefix: ${variantPath}` };
	}
	const relative = variantPath.slice(prefix.length);
	const rootResolved = path.resolve(root);
	if (!path.resolve(root, relative).startsWith(`${rootResolved}${path.sep}`)) {
		return { relative: null, problem: `manifest path escapes the output root: ${variantPath}` };
	}
	return { relative, problem: null };
}

/** @param {string[]} problems */
async function verifyCommitted(problems) {
	const root = COLLECTION.outputDir;
	const manifestRaw = await readFile(path.join(root, 'tarot-art.json'), 'utf8');
	const manifest = JSON.parse(manifestRaw);

	/** @type {Map<string, { sha256: string; bytes: number }>} */
	const expected = new Map();
	for (const asset of [...Object.values(manifest.faces), ...Object.values(manifest.backs)]) {
		for (const variant of asset.variants) {
			const resolved = manifestRelativePath(variant.path, root);
			// Narrow on `relative`, not `problem`: it is the discriminant that
			// tells the checker which arm of the union this is.
			if (resolved.relative === null) {
				problems.push(resolved.problem);
				continue;
			}
			expected.set(resolved.relative, { sha256: variant.sha256, bytes: variant.bytes });
		}
	}

	const committed = await walk(root);
	for (const name of committed.filter((f) => f.toLowerCase().endsWith('.png'))) {
		problems.push(`PNG in committed output: ${name}`);
	}
	for (const name of committed) {
		if (name === 'tarot-art.json' || name === RUNTIME_MANIFEST_BASENAME) continue;
		if (!expected.has(name)) problems.push(`file not listed in manifest: ${name}`);
	}
	for (const [name, want] of expected) {
		const filePath = path.join(root, name);
		try {
			// `lstat`, and reject links outright: the containment check above is
			// lexical, so a symlink committed inside the output root could still
			// point outside it and have its target's bytes hashed in place of a
			// derivative that is absent. `walk` cannot catch that either — it
			// enumerates `isFile()` entries, and a symlink is not one, so such a
			// link is invisible to the stray-file check. A derivative is always a
			// regular file.
			const info = await lstat(filePath);
			if (!info.isFile()) {
				problems.push(`manifest path is not a regular file: ${name}`);
				continue;
			}
			const bytes = await readFile(filePath);
			if (sha256(bytes) !== want.sha256) problems.push(`hash mismatch: ${name}`);
			if (info.size !== want.bytes) problems.push(`size mismatch: ${name}`);
		} catch {
			problems.push(`manifest lists a missing file: ${name}`);
		}
	}

	// The runtime projection is what the app actually imports, so a stale or
	// hand-edited copy is exactly the "committed output disagrees with the
	// committed manifest" failure this script exists to catch. Byte-for-byte,
	// not structural: both files are emitted by the same serializer, so any
	// difference at all is drift.
	try {
		const committedRuntime = await readFile(path.join(root, RUNTIME_MANIFEST_BASENAME), 'utf8');
		if (committedRuntime !== serializeManifest(projectRuntimeManifest(manifest))) {
			problems.push(`runtime projection drifted from the manifest: ${RUNTIME_MANIFEST_BASENAME}`);
		}
	} catch {
		problems.push(`runtime projection missing: ${RUNTIME_MANIFEST_BASENAME}`);
	}
	return expected.size;
}

/** @param {string[]} problems */
async function verifyFromSource(problems) {
	const committedRoot = COLLECTION.outputDir;
	// Imported here, not at module scope: `build.mjs` pulls in Sharp's
	// platform-specific native binary, and the default mode must not depend on
	// it — that mode is the one the CI gate runs, and it only hashes committed
	// files.
	const { buildCollection } = await import('./build.mjs');
	const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'tarot-art-verify-'));
	try {
		await buildCollection({ outputRoot: temporaryRoot });
		const rebuilt = await walk(temporaryRoot);
		const committed = await walk(committedRoot);
		for (const name of rebuilt.filter((f) => !committed.includes(f))) {
			problems.push(`missing from committed output: ${name}`);
		}
		for (const name of committed.filter((f) => !rebuilt.includes(f))) {
			problems.push(`unexpected committed file: ${name}`);
		}
		for (const name of rebuilt.filter((f) => committed.includes(f))) {
			const [a, b] = await Promise.all([
				readFile(path.join(temporaryRoot, name)),
				readFile(path.join(committedRoot, name))
			]);
			if (sha256(a) !== sha256(b)) problems.push(`content mismatch vs rebuild: ${name}`);
		}
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true });
	}
}

async function main() {
	const fromSource = process.argv.includes('--from-source');
	/** @type {string[]} */
	const problems = [];

	const checked = await verifyCommitted(problems);
	if (fromSource) await verifyFromSource(problems);

	if (problems.length > 0) {
		for (const problem of problems) console.error(`tarot-art:verify FAIL — ${problem}`);
		process.exit(1);
	}
	console.log(
		`tarot-art:verify OK — ${checked} committed files match the committed manifest` +
			(fromSource ? ' AND a clean rebuild on this machine' : '')
	);
}

// Guarded like `build.mjs`'s CLI block, and with the same `fileURLToPath`
// reasoning: importing this module (as the unit tests do, for
// `manifestRelativePath`) must not run a full verification pass.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
