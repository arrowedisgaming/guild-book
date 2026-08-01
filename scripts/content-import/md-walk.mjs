// @ts-nocheck — plain ESM build script, matching the other content-import scripts.
// Chapter-walking extractor for the rules reference: parses a chapter's heading
// structure into a tree with structural locators (parent path + occurrence), so
// every H1/H2 can be emitted as a rule entry exactly once and duplicated
// headings (Ch7 repeats its flow steps under "GMing the Challenge") stay
// addressable. Pure functions over strings — no filesystem access — so the
// tests never need the gitignored vault.

import { createHash } from 'node:crypto';

/** ATX heading match: returns { level, text } or null. Mirrors md-lib. */
function parseHeadingLine(line) {
	const m = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
	return m ? { level: m[1].length, text: m[2].trim() } : null;
}

/**
 * Scans a chapter into an ordered heading list with structural locators.
 * `path` = ancestor texts joined by '/', matching manifest locator syntax;
 * `occurrence` disambiguates when even the full path repeats.
 */
export function scanHeadings(markdown) {
	// Same whole-line-bold promotion md-lib applies, so both see one structure.
	const lines = markdown.split('\n').map((l) => l.replace(/^\s*\*\*(.+?)\*\*\s*$/, '### $1'));
	const headings = [];
	const stack = [];
	const pathCounts = new Map();
	for (let i = 0; i < lines.length; i++) {
		const h = parseHeadingLine(lines[i]);
		if (!h) continue;
		const text = h.text.replace(/[*_`]/g, '').trim();
		while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
		const path = [...stack.map((s) => s.text), text].join('/');
		const key = path.toLowerCase();
		const occurrence = (pathCounts.get(key) ?? 0) + 1;
		pathCounts.set(key, occurrence);
		headings.push({ level: h.level, text, line: i, path, occurrence });
		stack.push({ level: h.level, text });
	}
	return { lines, headings };
}

/** End line (exclusive) of a heading's subtree: next heading at <= its level. */
function subtreeEnd(headings, index, totalLines) {
	for (let i = index + 1; i < headings.length; i++) {
		if (headings[i].level <= headings[index].level) return headings[i].line;
	}
	return totalLines;
}

function locatorMatches(h, loc) {
	return h.path.toLowerCase() === loc.at.toLowerCase() && h.occurrence === (loc.occurrence ?? 1);
}

function findByLocator(headings, loc, kind) {
	const hit = headings.find((h) => locatorMatches(h, loc));
	if (!hit) throw new Error(`${kind} locator matches no heading: ${JSON.stringify(loc.at)} (occurrence ${loc.occurrence ?? 1})`);
	return hit;
}

/**
 * Walks a chapter into emission candidates (H1s, H2s, and splitDeeper H3s) and
 * a coverage ledger. Ownership: an H1 owns only its pre-first-child prose; an
 * H2 owns its subtree minus splitDeeper H3 subtrees; skipped subtrees vanish.
 * Every candidate body is a disjoint slice of the source — the exactly-once
 * test in the suite is the guarantee full coverage rests on.
 */
export function walkChapter(markdown, config) {
	const { lines, headings } = scanHeadings(markdown);
	const skips = (config.skip ?? []).map((s) => ({ ...s, heading: findByLocator(headings, s, 'skip') }));
	const deepers = (config.splitDeeper ?? []).map((s) => ({ ...s, heading: findByLocator(headings, s, 'splitDeeper') }));

	const skipRanges = skips.map((s) => {
		const idx = headings.indexOf(s.heading);
		return [s.heading.line, subtreeEnd(headings, idx, lines.length)];
	});
	const inSkip = (line) => skipRanges.some(([a, b]) => line >= a && line < b);
	const isDeeper = (h) => deepers.some((d) => d.heading === h);

	const candidates = [];
	const ledger = [];
	for (let i = 0; i < headings.length; i++) {
		const h = headings[i];
		const tracked = h.level <= 2 || isDeeper(h);
		if (!tracked) continue;
		if (inSkip(h.line)) {
			const skip = skips.find((s) => s.heading === h);
			// Only the skip root gets a ledger row; descendants are covered by it.
			if (skip) ledger.push({ locator: h.path, occurrence: h.occurrence, level: h.level, disposition: 'skipped', reason: skip.reason });
			continue;
		}
		const end = subtreeEnd(headings, i, lines.length);
		// Nested tracked headings inside this subtree own their slices, not us.
		const carveOuts = [];
		for (let j = i + 1; j < headings.length && headings[j].line < end; j++) {
			const child = headings[j];
			if (child.level <= 2 || isDeeper(child)) {
				carveOuts.push([child.line, subtreeEnd(headings, j, lines.length)]);
			}
		}
		const owned = [];
		for (let line = h.line + 1; line < end; line++) {
			if (inSkip(line)) continue;
			if (carveOuts.some(([a, b]) => line >= a && line < b)) continue;
			owned.push(lines[line]);
		}
		while (owned.length && owned[0].trim() === '') owned.shift();
		while (owned.length && owned[owned.length - 1].trim() === '') owned.pop();

		if (owned.length === 0) {
			ledger.push({ locator: h.path, occurrence: h.occurrence, level: h.level, disposition: 'container' });
			continue;
		}
		candidates.push({ locator: h.path, occurrence: h.occurrence, level: h.level, text: h.text, bodyLines: owned });
		ledger.push({ locator: h.path, occurrence: h.occurrence, level: h.level, disposition: 'candidate' });
	}
	return { candidates, ledger };
}

/** "Chapter 2: X" / "8 - X" / "1. X" -> "X"; used for both slugs and titles. */
function stripOrdinal(text) {
	return text
		.replace(/^chapter\s+\d+\s*[:.–-]\s*/i, '')
		.replace(/^\d+\s*[.:–-]?\s*/, '')
		.trim();
}

export function cleanTitle(text) {
	return stripOrdinal(text.replace(/\s+/g, ' ').trim());
}

export function defaultSlug(text) {
	return stripOrdinal(text.toLowerCase())
		.replace(/[‘'’]/g, '')
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/**
 * Assigns final ids/titles to candidates. Priority per candidate:
 * idAliases[locator] (legacy id preservation) > ids[locator] (explicit, for
 * collisions) > splitDeeper[].id (the id a lifted H3 declares inline) >
 * `${section}-${defaultSlug(text)}`. Collisions and unmatched or
 * non-bijective alias maps are build errors — never auto-suffixed, because
 * suffixes are insertion-order-dependent and these ids are permanent URLs.
 */
export function resolveEntries(candidates, config) {
	const byLocator = (map, kind) => {
		const out = new Map();
		for (const [at, id] of Object.entries(map ?? {})) {
			const hit = candidates.find((c) => c.locator.toLowerCase() === at.toLowerCase());
			if (!hit) throw new Error(`${kind} locator matches no candidate: ${JSON.stringify(at)}`);
			out.set(hit, id);
		}
		return out;
	};
	const aliases = byLocator(config.idAliases, 'idAliases');
	const explicit = byLocator(config.ids, 'ids');
	// A splitDeeper entry's own `id` names the lifted H3's final id inline,
	// so a manifest author doesn't have to repeat the same locator a second
	// time in `ids` just to assign it.
	const deeperIds = byLocator(
		Object.fromEntries((config.splitDeeper ?? []).filter((d) => d.id).map((d) => [d.at, d.id])),
		'splitDeeper'
	);

	const aliasValues = [...aliases.values()];
	if (new Set(aliasValues).size !== aliasValues.length) {
		throw new Error(`idAliases must be bijective; duplicate alias target in ${JSON.stringify(aliasValues)}`);
	}

	const entries = candidates.map((c) => ({
		...c,
		id: aliases.get(c) ?? explicit.get(c) ?? deeperIds.get(c) ?? `${config.section}-${defaultSlug(c.text)}`,
		title: cleanTitle(c.text)
	}));

	const seen = new Map();
	for (const e of entries) {
		if (seen.has(e.id)) {
			throw new Error(
				`id collision "${e.id}":\n  ${seen.get(e.id).locator}\n  ${e.locator}\n` +
					`Resolve it with an explicit "ids" entry keyed by locator.`
			);
		}
		seen.set(e.id, e);
	}
	return entries;
}

/**
 * Full walk of one chapter file's text into rule entries + its ledger chapter.
 * Pure: body pipeline, lint, and omitRange are injected so tests run without
 * the vault and md-rules.mjs stays the only module with filesystem knowledge.
 */
export function buildWalk(markdown, walkCfg, deps) {
	const { walkRuleBody, lintBody, omitRange } = deps;
	const { candidates, ledger } = walkChapter(markdown, walkCfg);
	const resolved = resolveEntries(candidates, walkCfg);
	const overrides = walkCfg.overrides ?? {};
	const known = new Set(resolved.map((e) => e.id));
	for (const key of Object.keys(overrides)) {
		if (!known.has(key)) throw new Error(`walk override for unknown id "${key}" in ${walkCfg.file}`);
	}

	const rules = resolved.map((e) => {
		const ov = overrides[e.id] ?? {};
		const body = omitRange(walkRuleBody(e.bodyLines), ov.omitRange);
		const problems = lintBody(body, ov);
		if (problems.length) throw new Error(`[rules#${e.id}] ${problems.join('; ')}`);
		return { id: e.id, section: walkCfg.section, title: ov.title ?? e.title, body, tags: ov.tags ?? [] };
	});

	const idByLocator = new Map(resolved.map((e) => [`${e.locator.toLowerCase()}#${e.occurrence}`, e.id]));
	const headings = ledger.map((row) =>
		row.disposition === 'candidate'
			? { ...row, disposition: 'emitted', id: idByLocator.get(`${row.locator.toLowerCase()}#${row.occurrence}`) }
			: row
	);
	return {
		rules,
		ledger: { file: walkCfg.file, section: walkCfg.section, sourceSha256: createHash('sha256').update(markdown).digest('hex'), headings }
	};
}
