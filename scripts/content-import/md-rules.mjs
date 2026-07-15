// Orchestrator: builds static/content-packs/hmtw/rules.json from the Markdown
// rulebook vault, driven by manifest/rules-md.json. Each manifest entry names a
// chapter file + heading; the body is extracted, callouts/examples stripped,
// and normalized to the app's markdown dialect. Manifest order = book order.
//
//   node scripts/content-import/md-rules.mjs            # write rules.json
//   node scripts/content-import/md-rules.mjs --check    # verify committed == fresh (no write)
//   node scripts/content-import/md-rules.mjs --dry-run  # preview, write nothing

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MD_DIR, extractRuleBody } from './md-lib.mjs';
import { PACK_DIR } from './pack.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(__dirname, 'manifest', 'rules-md.json');
const RULES_JSON = join(PACK_DIR, 'rules.json');

/** Remove an explicitly documented corrupt range without inventing missing book text. */
function omitRange(body, range) {
	if (!range) return body;
	const start = body.indexOf(range.from);
	const end = body.indexOf(range.to, start + range.from.length);
	if (start === -1 || end === -1) {
		throw new Error(`omitRange anchors not found: ${JSON.stringify(range)}`);
	}
	return `${body.slice(0, start).trimEnd()}\n\n${body.slice(end).trimStart()}`
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/** Problems that must never reach the committed pack. */
function lintBody(body, entry) {
	const problems = [];
	if (body.trim() === '') problems.push('empty body');
	if (/\[\[|\]\]/.test(body)) problems.push('unconverted wikilink');
	if (/PLACEHOLDER/i.test(body)) problems.push('PLACEHOLDER marker');
	if (/\bpage\s+\d+/i.test(body)) problems.push('page cross-reference');
	if (/\b(?:SWORDS|DISKS|BATONS)\b/.test(body)) problems.push('leftover suit-glyph token');
	if (/[^\n][ \t]+#{2,6}\s/.test(body)) problems.push('inline heading marker');
	for (const expected of entry.mustContain ?? []) {
		if (!body.includes(expected)) problems.push(`missing sentinel ${JSON.stringify(expected)}`);
	}
	for (const forbidden of entry.mustNotContain ?? []) {
		if (body.includes(forbidden)) problems.push(`forbidden corrupt fragment ${JSON.stringify(forbidden)}`);
	}
	return problems;
}

function build() {
	if (!existsSync(MD_DIR)) {
		throw new Error(
			`Markdown vault not found at ${MD_DIR}. The rules reference is built from the gitignored assets-src/HMTW_md/ book export.`
		);
	}
	const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
	const rules = [];
	for (const entry of manifest) {
		const body = omitRange(
			extractRuleBody(entry.file, entry.heading, entry.until, entry.after, {
				keepCallouts: entry.keepCallouts
			}),
			entry.omitRange
		);
		const problems = lintBody(body, entry);
		if (problems.length) throw new Error(`[rules#${entry.id}] ${problems.join('; ')}`);
		rules.push({
			id: entry.id,
			section: entry.section,
			title: entry.title,
			body,
			tags: entry.tags
		});
	}
	return rules;
}

function main() {
	const args = process.argv.slice(2);
	const rules = build();

	if (args.includes('--check')) {
		const committed = JSON.parse(readFileSync(RULES_JSON, 'utf8'));
		let drift = 0;
		for (const fresh of rules) {
			const have = committed.find((r) => r.id === fresh.id);
			if (!have) {
				console.error(`MISSING committed rule ${fresh.id}`);
				drift++;
				continue;
			}
			if (JSON.stringify(have) !== JSON.stringify(fresh)) {
				console.error(`DRIFT ${fresh.id}`);
				drift++;
			}
		}
		if (committed.length !== rules.length) {
			console.error(`count mismatch: committed ${committed.length} vs fresh ${rules.length}`);
			drift++;
		}
		console.log(`\nChecked ${rules.length} rules, ${drift} drifted.`);
		if (drift) process.exit(1);
		return;
	}

	for (const r of rules) {
		console.log(`  ${r.id} (${r.body.length} chars): ${r.body.slice(0, 90).replace(/\n/g, ' ')}...`);
	}

	if (!args.includes('--dry-run')) {
		writeFileSync(RULES_JSON, JSON.stringify(rules, null, '\t') + '\n', 'utf8');
		console.log(`\nWrote ${rules.length} rules to ${RULES_JSON}`);
	} else {
		console.log(`\n${rules.length} rules previewed (no write).`);
	}
}

main();
