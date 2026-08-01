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
 *      manifest itself — no strays;
 *   3. no PNG anywhere in the committed output.
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
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { COLLECTION } from './source-map.mjs';

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

/** @param {string[]} problems */
async function verifyCommitted(problems) {
	const root = COLLECTION.outputDir;
	const manifestRaw = await readFile(path.join(root, 'tarot-art.json'), 'utf8');
	const manifest = JSON.parse(manifestRaw);

	/** @type {Map<string, { sha256: string; bytes: number }>} */
	const expected = new Map();
	for (const asset of [...Object.values(manifest.faces), ...Object.values(manifest.backs)]) {
		for (const variant of asset.variants) {
			// Manifest paths are public URLs under the collection prefix; map
			// them back to files under the output root.
			const relative = variant.path.replace(`${COLLECTION.publicPathPrefix}/`, '');
			expected.set(relative, { sha256: variant.sha256, bytes: variant.bytes });
		}
	}

	const committed = await walk(root);
	for (const name of committed.filter((f) => f.toLowerCase().endsWith('.png'))) {
		problems.push(`PNG in committed output: ${name}`);
	}
	for (const name of committed) {
		if (name === 'tarot-art.json') continue;
		if (!expected.has(name)) problems.push(`file not listed in manifest: ${name}`);
	}
	for (const [name, want] of expected) {
		const filePath = path.join(root, name);
		try {
			const [bytes, info] = await Promise.all([readFile(filePath), stat(filePath)]);
			if (sha256(bytes) !== want.sha256) problems.push(`hash mismatch: ${name}`);
			if (info.size !== want.bytes) problems.push(`size mismatch: ${name}`);
		} catch {
			problems.push(`manifest lists a missing file: ${name}`);
		}
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

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
