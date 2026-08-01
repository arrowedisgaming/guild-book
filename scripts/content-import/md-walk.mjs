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
