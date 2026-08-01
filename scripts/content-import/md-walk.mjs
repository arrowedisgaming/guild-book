// @ts-nocheck — plain ESM build script, matching the other content-import scripts.
// Chapter-walking extractor for the rules reference: parses a chapter's heading
// structure into a tree with structural locators (parent path + occurrence), so
// every H1/H2 can be emitted as a rule entry exactly once and duplicated
// headings (Ch7 repeats its flow steps under "GMing the Challenge") stay
// addressable. Pure functions over strings — no filesystem access — so the
// tests never need the gitignored vault.

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
