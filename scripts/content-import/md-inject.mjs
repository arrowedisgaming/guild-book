// General Markdown → pack-JSON injector. Fills the PROSE fields of the existing
// content-pack collections (descriptions, effects, arête triggers, …) from the
// clean per-chapter Markdown vault, preserving every structured/mechanical
// field (ids, slots, tiers, talent sources, kin talent ids, stage numbers, …).
//
// Manifests live in manifest/md/<packfile>.json as an array of entries:
//   { "id": "berserkergang", "field": "description",
//     "file": "04 - Chapter 4 - Kith and Kin.md",
//     "heading": "Fireblooded orc talent: Berserkergang" }
// Optional per-entry keys: "until" (stop heading), "plain" (strip markdown to a
// single plain-text line — for short list-item fields), "list" (extract the
// section's bullet items as a string array for an array field).
//
//   node scripts/content-import/md-inject.mjs               # inject all
//   node scripts/content-import/md-inject.mjs --only talents.json
//   node scripts/content-import/md-inject.mjs --check       # verify committed == fresh
//   node scripts/content-import/md-inject.mjs --dry-run

import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractRuleBody, extractSection, stripCallouts, normalizeMarkdown, MD_DIR } from './md-lib.mjs';
import { PACK_DIR, setByFieldPath, readByFieldPath } from './pack.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MD_MANIFEST_DIR = join(__dirname, 'manifest', 'md');

/** Strip markdown emphasis/markers down to a single clean plain-text line. */
function toPlain(md) {
	return md
		.replace(/\*\*|\*|_|`/g, '')
		.replace(/^\s*-\s+/gm, '')
		.replace(/\s*\n\s*/g, ' ')
		.replace(/\s{2,}/g, ' ')
		.trim();
}

/** Extract a section's top-level bullet items as an array of plain strings. */
function extractListItems(file, heading, until, after) {
	const { lines } = extractSection(file, heading, until, after);
	const clean = normalizeMarkdown(stripCallouts(lines));
	return clean
		.split('\n')
		.filter((l) => /^-\s+/.test(l))
		.map((l) => toPlain(l));
}

/** Slice a normalized section body between anchors. `from` is inclusive,
 * `fromAfter` exclusive (starts just past the anchor — e.g. a "Stage 1:" label). */
function sliceBody(body, { from, fromAfter, to }) {
	const anchor = fromAfter ?? from;
	let start = anchor ? body.indexOf(anchor) : 0;
	if (start === -1) throw new Error(`start anchor not found: ${JSON.stringify(anchor)}`);
	if (fromAfter) start += fromAfter.length;
	const rest = to ? body.indexOf(to, start) : -1;
	const end = rest === -1 ? body.length : rest;
	return body.slice(start, end).trim();
}

/** Collect the given 0-based columns of a section's markdown pipe-table into one flat array (header/separator rows dropped). */
function extractTableColumns(file, heading, columns) {
	const { lines } = extractSection(file, heading);
	const rows = lines
		.filter((l) => /^\s*\|.*\|\s*$/.test(l) && !/^\s*\|[\s:|-]+\|\s*$/.test(l))
		.map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
	rows.shift(); // drop the header row
	// Column-by-column (each column runs A–Z on its own), not interleaved by row.
	const out = [];
	for (const c of columns) for (const row of rows) if (row[c]) out.push(row[c]);
	return out;
}

/** Produce the value for one manifest entry from the Markdown source. */
function valueFor(entry) {
	if (entry.tableColumns) return extractTableColumns(entry.file, entry.heading, entry.tableColumns);
	if (entry.list) return extractListItems(entry.file, entry.heading, entry.until, entry.after);
	let body = extractRuleBody(entry.file, entry.heading, entry.until, entry.after);
	if (entry.from || entry.fromAfter || entry.to) body = sliceBody(body, entry);
	if (entry.dropCureCost) {
		// "Requires 1 charge to cure." / "Requires 5 charges to quit." lines are the
		// stored cureCost, not effect text. (XP costs like "Requires 1XP…" are kept.)
		body = body
			.replace(/\s*Requires \d+ charges? to [a-z]+[^.]*\.\s*/gi, ' ')
			.replace(/[ \t]{2,}/g, ' ')
			.replace(/\n{3,}/g, '\n\n')
			.trim();
	}
	return entry.plain ? toPlain(body) : body;
}

function loadManifest(name) {
	return JSON.parse(readFileSync(join(MD_MANIFEST_DIR, name), 'utf8'));
}

function runManifest(packFile, dryRun) {
	const packPath = join(PACK_DIR, packFile);
	const pack = JSON.parse(readFileSync(packPath, 'utf8'));
	const entries = loadManifest(packFile);
	const results = [];
	for (const entry of entries) {
		const value = valueFor(entry);
		const bad =
			(typeof value === 'string' && value.trim() === '') ||
			(Array.isArray(value) && value.length === 0) ||
			/\[\[|\]\]/.test(JSON.stringify(value)) ||
			/PLACEHOLDER/i.test(JSON.stringify(value));
		if (bad) throw new Error(`[${packFile}#${entry.id}.${entry.field}] empty/invalid extraction`);
		const target = Array.isArray(pack) ? pack.find((e) => e.id === entry.id) : pack;
		if (!target) throw new Error(`[${packFile}] no entry with id ${JSON.stringify(entry.id)}`);
		if (!dryRun) setByFieldPath(target, entry.field, value);
		results.push({ id: entry.id, field: entry.field, value });
	}
	if (!dryRun) writeFileSync(packPath, JSON.stringify(pack, null, '\t') + '\n', 'utf8');
	return results;
}

function checkManifest(packFile) {
	const pack = JSON.parse(readFileSync(join(PACK_DIR, packFile), 'utf8'));
	const entries = loadManifest(packFile);
	let drift = 0;
	for (const entry of entries) {
		const fresh = valueFor(entry);
		const target = Array.isArray(pack) ? pack.find((e) => e.id === entry.id) : pack;
		let have;
		try {
			// read committed value via the same path walker used to write
			have = readByFieldPath(target, entry.field);
		} catch {
			have = undefined;
		}
		if (JSON.stringify(have) !== JSON.stringify(fresh)) {
			console.error(`DRIFT ${packFile}#${entry.id}.${entry.field}`);
			drift++;
		}
	}
	return drift;
}

function main() {
	if (!existsSync(MD_DIR)) throw new Error(`Markdown vault not found at ${MD_DIR}.`);
	const args = process.argv.slice(2);
	const onlyIdx = args.indexOf('--only');
	const only = onlyIdx !== -1 ? args[onlyIdx + 1] : null;
	const dryRun = args.includes('--dry-run');
	const check = args.includes('--check');

	const manifests = readdirSync(MD_MANIFEST_DIR).filter((f) => f.endsWith('.json'));
	const targets = only ? manifests.filter((f) => f === only) : manifests;

	if (check) {
		let drift = 0;
		let n = 0;
		for (const m of targets) {
			drift += checkManifest(m);
			n += loadManifest(m).length;
		}
		console.log(`\nChecked ${n} fields across ${targets.length} collections, ${drift} drifted.`);
		if (drift) process.exit(1);
		return;
	}

	let total = 0;
	for (const m of targets) {
		const results = runManifest(m, dryRun);
		total += results.length;
		for (const r of results) {
			const preview = Array.isArray(r.value) ? `[${r.value.length} items]` : r.value.slice(0, 70).replace(/\n/g, ' ');
			console.log(`  ${m}#${r.id}.${r.field}: ${preview}`);
		}
	}
	console.log(`\n${total} field(s) ${dryRun ? 'previewed' : 'injected'}.`);
}

main();
