// Builds static/content-packs/hmtw/spells.json from the Markdown sorcery
// appendix. Each of the four "# Spells of the <realm>" chapters holds a run of
// "## <Spell>" entries; every spell has a "### Component:" sub-section (the
// material component, in italics) followed by its effect text.
//
//   node scripts/content-import/md-spells.mjs            # write spells.json
//   node scripts/content-import/md-spells.mjs --check    # verify committed == fresh
//   node scripts/content-import/md-spells.mjs --dry-run  # preview, write nothing

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MD_DIR, stripCallouts, normalizeMarkdown } from './md-lib.mjs';
import { PACK_DIR } from './pack.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SORCERY_FILE = join(MD_DIR, '11 - Appendix A - Sorcery.md');
const SPELLS_JSON = join(PACK_DIR, 'spells.json');

/** "# Spells of the <realm>" heading -> tradition id (matches the four "Magic of the …" talents). */
const TRADITION_BY_CHAPTER = {
	'spells of the waste': 'wastes',
	'spells of the weald': 'weald',
	'spells of the weird': 'weird',
	'spells of the welkin': 'welkin'
};

function slugify(name) {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');
}

/** Parses the appendix into raw per-spell records: { name, tradition, lines }. */
function collectSpells() {
	const lines = readFileSync(SORCERY_FILE, 'utf8').split('\n');
	const spells = [];
	let tradition = null;
	let current = null;

	for (const line of lines) {
		const h1 = /^#\s+(.*\S)\s*$/.exec(line);
		const h2 = /^##\s+(.*\S)\s*$/.exec(line);
		if (h1) {
			const key = h1[1].replace(/[*_`]/g, '').trim().toLowerCase();
			tradition = TRADITION_BY_CHAPTER[key] ?? null;
			current = null;
			continue;
		}
		if (h2 && tradition) {
			current = { name: h2[1].trim(), tradition, lines: [] };
			spells.push(current);
			continue;
		}
		if (current) current.lines.push(line);
	}
	return spells;
}

/** Splits a spell's body lines into { component, descriptionLines }, dropping the "Component:" heading. */
function splitComponent(bodyLines) {
	let i = 0;
	// find "### Component:"
	while (i < bodyLines.length && !/^###\s+Component:?/i.test(bodyLines[i])) i++;
	if (i === bodyLines.length) return { component: '', descriptionLines: bodyLines };

	// The component is one italic paragraph. The Markdown export may hard-wrap it
	// across multiple lines, so consume the whole non-blank block.
	let j = i + 1;
	while (j < bodyLines.length && bodyLines[j].trim() === '') j++;
	let k = j;
	while (k < bodyLines.length && bodyLines[k].trim() !== '') k++;
	const componentRaw = bodyLines
		.slice(j, k)
		.map((line) => line.trim())
		.join(' ');
	const component = componentRaw.replace(/^[*_]+|[*_]+$/g, '').trim();

	// description = everything except the Component heading + complete component block
	const descriptionLines = [...bodyLines.slice(0, i), ...bodyLines.slice(k)];
	return { component, descriptionLines };
}

function build() {
	if (!existsSync(SORCERY_FILE)) {
		throw new Error(`Sorcery appendix not found at ${SORCERY_FILE} (gitignored Markdown vault).`);
	}
	const raw = collectSpells();
	const spells = raw.map((s) => {
		const { component, descriptionLines } = splitComponent(s.lines);
		const description = normalizeMarkdown(stripCallouts(descriptionLines));
		const problems = [];
		if (!component) problems.push('missing component');
		if (!description) problems.push('empty description');
		if (/\[\[|\]\]/.test(component + description)) problems.push('unconverted wikilink');
		if (problems.length) throw new Error(`[spell ${s.name}] ${problems.join('; ')}`);
		return { id: slugify(s.name), name: s.name, tradition: s.tradition, component, description };
	});
	return spells;
}

function main() {
	const args = process.argv.slice(2);
	const spells = build();

	if (args.includes('--check')) {
		const committed = JSON.parse(readFileSync(SPELLS_JSON, 'utf8'));
		let drift = 0;
		for (const fresh of spells) {
			const have = committed.find((c) => c.id === fresh.id);
			if (JSON.stringify(have) !== JSON.stringify(fresh)) {
				console.error(`DRIFT ${fresh.id}`);
				drift++;
			}
		}
		if (committed.length !== spells.length) {
			console.error(`count mismatch: committed ${committed.length} vs fresh ${spells.length}`);
			drift++;
		}
		console.log(`\nChecked ${spells.length} spells, ${drift} drifted.`);
		if (drift) process.exit(1);
		return;
	}

	const byTradition = {};
	for (const s of spells) byTradition[s.tradition] = (byTradition[s.tradition] ?? 0) + 1;
	console.log(`${spells.length} spells:`, byTradition);
	for (const s of spells.slice(0, 3)) {
		console.log(`  ${s.id} [${s.tradition}] component="${s.component.slice(0, 50)}…" desc=${s.description.length}c`);
	}

	if (!args.includes('--dry-run')) {
		writeFileSync(SPELLS_JSON, JSON.stringify(spells, null, '\t') + '\n', 'utf8');
		console.log(`\nWrote ${spells.length} spells to ${SPELLS_JSON}`);
	} else {
		console.log(`\n${spells.length} spells previewed (no write).`);
	}
}

main();
