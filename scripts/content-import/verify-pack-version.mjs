// @ts-nocheck — plain ESM build script, not part of the typed app surface.
//
// Content-pack integrity and version enforcement.
//
//   node scripts/content-import/verify-pack-version.mjs           # verify digest
//   node scripts/content-import/verify-pack-version.mjs --write   # record digest
//
// Two checks, both cheap and both source-free so CI can run them without the
// gitignored Markdown vault:
//
//   1. Integrity — SHA-256 over every generated content file, in manifest-key
//      order, must equal index.json's committed `contentDigest`. This is what
//      covers table *text* in CI: md-procedures.mjs --check-generated cannot
//      re-extract prose without the book, so the digest is the guarantee that
//      committed output has not been hand-edited or corrupted.
//   2. Version — when CONTENT_BASE_REF is set, compare against that revision's
//      index.json: if the digest changed but the semantic version did not, fail.
//      A content change must bump the pack version, or a session that pinned
//      "1.2.0" could be served different rules than it started with.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACK_DIR } from './pack.mjs';

const INDEX_PATH = join(PACK_DIR, 'index.json');

/** SHA-256 over each generated file, keyed and ordered so it cannot drift. */
function computeDigest(index) {
	const hash = createHash('sha256');
	const orderedFiles = Object.entries(index.files).sort(([a], [b]) => a.localeCompare(b));
	for (const [key, file] of orderedFiles) {
		hash.update(key);
		hash.update('\0');
		hash.update(readFileSync(join(PACK_DIR, file)));
		hash.update('\0');
	}
	return hash.digest('hex');
}

/** An absent or all-zero base (a repository's first push) has nothing to compare. */
function readBaseIndex(ref) {
	if (!ref || /^0+$/.test(ref)) return null;
	try {
		const raw = execFileSync('git', ['show', `${ref}:static/content-packs/hmtw/index.json`], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore']
		});
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

function main() {
	const args = process.argv.slice(2);
	const index = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
	const digest = computeDigest(index);

	if (args.includes('--write')) {
		writeFileSync(INDEX_PATH, JSON.stringify({ ...index, contentDigest: digest }, null, '\t') + '\n');
		console.log(`Recorded contentDigest ${digest}`);
		return;
	}

	if (index.contentDigest !== digest) {
		console.error(
			`Content digest mismatch.\n  committed: ${index.contentDigest ?? '(none)'}\n  actual:    ${digest}\n` +
				'Generated content changed without recording it. Run `npm run content:build`, then ' +
				'`node scripts/content-import/verify-pack-version.mjs --write`, and bump index.json version.'
		);
		process.exit(1);
	}

	const base = readBaseIndex(process.env.CONTENT_BASE_REF);
	if (!base) {
		console.log(
			`Content digest OK (${digest.slice(0, 12)}…). No comparable base revision — verified current integrity only.`
		);
		return;
	}

	if (base.contentDigest !== digest && base.version === index.version) {
		console.error(
			`Content changed but the pack version did not.\n  version: ${index.version}\n` +
				`  base digest: ${base.contentDigest ?? '(none)'}\n  this digest: ${digest}\n` +
				'A session pins its pack version, so generated content must never change under a version it already served. Bump index.json version.'
		);
		process.exit(1);
	}

	console.log(
		`Content digest OK (${digest.slice(0, 12)}…); version ${index.version}${
			base.version === index.version ? ' unchanged, content unchanged' : ` (was ${base.version})`
		}.`
	);
}

main();
