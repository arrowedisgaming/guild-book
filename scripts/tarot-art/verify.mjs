/**
 * Task 2: read-only verification of the committed tarot artwork (issue #10).
 *
 * Rebuilds the full derivative set from the ignored sources into a temporary
 * directory, then compares: the manifest byte-for-byte, and every emitted
 * file's hash against the committed file under `static/`. Also validates
 * that no PNG has leaked into the committed output. Deletes only its own
 * temporary output.
 *
 * Scope honesty (Amendment 2): this proves derivation fidelity on THIS
 * machine, with this Sharp/libvips build — it needs the ignored sources and
 * so can never run in CI. The CI-safe committed-files-vs-manifest check is a
 * separate, coordinated follow-up (`tarot-art:verify:ci`).
 */

import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { buildCollection } from './build.mjs';
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

async function main() {
	const committedRoot = COLLECTION.outputDir;
	const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'tarot-art-verify-'));
	/** @type {string[]} */
	const problems = [];
	try {
		await buildCollection({ outputRoot: temporaryRoot });

		const rebuilt = await walk(temporaryRoot);
		const committed = await walk(committedRoot);

		for (const name of committed.filter((f) => f.toLowerCase().endsWith('.png'))) {
			problems.push(`PNG in committed output: ${name}`);
		}
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
			if (sha256(a) !== sha256(b)) problems.push(`content mismatch: ${name}`);
		}
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true });
	}

	if (problems.length > 0) {
		for (const problem of problems) console.error(`tarot-art:verify FAIL — ${problem}`);
		process.exit(1);
	}
	console.log('tarot-art:verify OK — committed output matches a clean rebuild on this machine');
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
