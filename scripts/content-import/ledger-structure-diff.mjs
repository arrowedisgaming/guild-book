// @ts-nocheck — plain ESM build script, not part of the typed app surface.
// Reconciliation scout: compares the committed coverage ledger's tracked
// heading structure (emitted/container/skipped rows) against the current
// vault, per chapter. LOST = the ledger locator no longer exists at that
// path/occurrence (a manifest re-point or alias is needed if it was emitted).
// NEW = a current vault heading is absent from the tracked ledger; deeper NEW
// rows are informational unless a manifest anchor must now address them.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { scanHeadings } from './md-walk.mjs';
import { MD_DIR } from './md-lib.mjs';

const key = (path, occurrence) => `${path.toLowerCase()}#${occurrence}`;

export function diffChapter(ledgerChapter, markdown) {
	const { headings } = scanHeadings(markdown);
	const vaultKeys = new Set(headings.map((h) => key(h.path, h.occurrence)));
	const ledgerKeys = new Set(ledgerChapter.headings.map((h) => key(h.locator, h.occurrence)));
	return {
		lost: ledgerChapter.headings.filter((h) => !vaultKeys.has(key(h.locator, h.occurrence))),
		added: headings.filter((h) => !ledgerKeys.has(key(h.path, h.occurrence)))
	};
}

function main() {
	const argAfter = (flag) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : null);
	const only = argAfter('--section');
	const ledgerPath = argAfter('--ledger') ?? 'scripts/content-import/manifest/rules-coverage-ledger.json';
	// resolve(), not join(): join(cwd, '/tmp/x') would nest an absolute path
	// under the repo; resolve() honors absolute --ledger arguments.
	const ledger = JSON.parse(readFileSync(resolve(process.cwd(), ledgerPath), 'utf8'));
	let lostTotal = 0;
	for (const ch of ledger) {
		if (only && ch.section !== only) continue;
		const { lost, added } = diffChapter(ch, readFileSync(join(MD_DIR, ch.file), 'utf8'));
		if (!lost.length && !added.length) continue;
		console.log(`=== ${ch.section} (${ch.file}) lost:${lost.length} new:${added.length}`);
		for (const h of lost) console.log(`  LOST L${h.level} [${h.disposition}] ${h.locator}#${h.occurrence}`);
		for (const h of added) console.log(`  NEW  L${h.level} ${h.path}#${h.occurrence}`);
		lostTotal += lost.filter((h) => h.disposition === 'emitted').length;
	}
	console.log(`lost emitted headings require manifest attention: ${lostTotal}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
