// @ts-nocheck — plain ESM build script, not part of the typed app surface.
// `scripts/` is outside tsconfig's `include`, so these were never typechecked; a
// test importing this module would otherwise drag the whole script tree into
// svelte-check under checkJs and report dozens of implicit-any errors.
// Markdown-source extraction for the rules reference. The book also exists as a
// clean per-chapter Markdown vault (gitignored, copyrighted) at
// assets-src/HMTW_md/ — proper heading structure, contiguous paragraphs,
// sidebars/quotes as callout blocks, cross-refs as wikilinks. That is a far
// better source for the dense prose chapters than column-cropped pdftotext, so
// the rules reference is extracted from Markdown instead of the PDF.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './pack.mjs';

export const MD_DIR = join(ROOT, 'assets-src', 'HMTW_md');

/** ATX heading match: returns { level, text } or null. */
function parseHeading(line) {
	const m = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
	return m ? { level: m[1].length, text: m[2].trim() } : null;
}

/** Normalize a heading's text for matching (strip emphasis/trailing punctuation/whitespace). */
function headingKey(text) {
	return text
		.replace(/[*_`]/g, '')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase();
}

/**
 * Extracts the lines of a section identified by its heading text, from the
 * heading (exclusive) up to the next heading of the same or higher level.
 *
 * @param {string} file chapter filename under MD_DIR
 * @param {string} heading exact heading text (emphasis/case-insensitive)
 * @param {string} [until] optional heading text at which to stop early (for
 *   splitting a section from a nested sub-section that should be its own entry)
 * @param {string} [after] optional landmark heading; the search for `heading`
 *   only begins after this one appears (disambiguates repeated headings like
 *   "Arête", which recurs once per kith)
 * @returns {{ level: number, lines: string[] }}
 */
export function extractSection(file, heading, until, after) {
	const raw = readFileSync(join(MD_DIR, file), 'utf8');
	// A few headings are emphasized as whole-line bold instead of ATX (e.g.
	// "**Dwarf arête talent: Iron Beards**"). Promote those to `###` so section
	// slicing sees them as headings.
	const lines = raw.split('\n').map((l) => l.replace(/^\s*\*\*(.+?)\*\*\s*$/, '### $1'));
	const wantKey = headingKey(heading);
	const untilKey = until ? headingKey(until) : null;
	const afterKey = after ? headingKey(after) : null;

	let start = -1;
	let level = 0;
	let seenAfter = !afterKey;
	for (let i = 0; i < lines.length; i++) {
		const h = parseHeading(lines[i]);
		if (!h) continue;
		if (!seenAfter) {
			if (headingKey(h.text) === afterKey) seenAfter = true;
			continue;
		}
		if (headingKey(h.text) === wantKey) {
			start = i + 1;
			level = h.level;
			break;
		}
	}
	if (start === -1) throw new Error(`heading not found in ${file}: ${JSON.stringify(heading)}`);

	const body = [];
	for (let i = start; i < lines.length; i++) {
		const h = parseHeading(lines[i]);
		if (h && h.level <= level) break;
		if (h && untilKey && headingKey(h.text) === untilKey) break;
		body.push(lines[i]);
	}
	return { level, lines: body };
}

/**
 * Converts Obsidian callout blocks into the app's markdown dialect instead of
 * dropping them. Opt-in per manifest entry via `keepCallouts`, because most
 * callouts are flavor sidebars that the rules reference deliberately excludes —
 * but a few carry actual rules (Ch7's "No peeking!" is the rulebook's statement
 * of the facedown-card privacy rule).
 *
 * The callout's title becomes a `###` sub-heading and its body becomes plain
 * paragraphs. The blockquote syntax must not survive: `renderMarkdown` in
 * src/lib/utils/markdown.ts has no blockquote branch and escapes `>` to `&gt;`,
 * so a retained `>` would render literally on the page.
 */
export function convertCallouts(lines) {
	const out = [];
	let inCallout = false;
	for (const line of lines) {
		const opener = /^\s*>\s*\[!\w+\]\s*(.*)$/.exec(line);
		if (opener) {
			inCallout = true;
			const title = opener[1].trim();
			if (out.length && out[out.length - 1].trim() !== '') out.push('');
			if (title) out.push(`### ${title}`, '');
			continue;
		}
		if (inCallout) {
			if (/^\s*>/.test(line)) {
				out.push(line.replace(/^\s*>\s?/, ''));
				continue;
			}
			if (line.trim() === '') {
				out.push('');
				continue;
			}
			inCallout = false;
		}
		// A stray blockquote outside a recognized callout: unquote rather than
		// leak `>` into the body.
		if (/^\s*>/.test(line)) {
			out.push(line.replace(/^\s*>\s?/, ''));
			continue;
		}
		out.push(line);
	}
	return out;
}

/** Drops Obsidian callout blocks (`> [!type] …` and their `>`-quoted continuation). */
export function stripCallouts(lines) {
	const out = [];
	let inCallout = false;
	for (const line of lines) {
		if (/^\s*>\s*\[!/.test(line)) {
			inCallout = true;
			continue;
		}
		if (inCallout) {
			// Callout continues while lines stay blockquote-quoted (or blank between quoted lines).
			if (/^\s*>/.test(line) || line.trim() === '') continue;
			inCallout = false;
		}
		// A stray blockquote line outside a recognized callout (rare) — drop it too.
		if (/^\s*>/.test(line)) continue;
		out.push(line);
	}
	return out;
}

/**
 * Drops sub-sections whose heading is an example/illustration (per the core-rules
 * scoping, worked examples and GM/player transcripts are excluded), from that
 * heading up to the next heading of the same or higher level.
 */
export function stripExampleSubsections(lines) {
	const out = [];
	let skipUntilLevel = 0; // 0 = not skipping
	for (const line of lines) {
		const h = parseHeading(line);
		if (skipUntilLevel) {
			if (h && h.level <= skipUntilLevel) {
				skipUntilLevel = 0; // fallthrough to reconsider this heading
			} else {
				continue;
			}
		}
		if (h && /^example\b/i.test(h.text)) {
			skipUntilLevel = h.level;
			continue;
		}
		out.push(line);
	}
	return out;
}

/**
 * Handles Obsidian wikilinks, which encode the book's cross-references. Most are
 * pure pointers that read as noise once flattened, so:
 *   1. A parenthetical whose only content is a wikilink — "(p. 125)", "(Watches)",
 *      "(Piercing and Critical damage)" — is dropped entirely.
 *   2. A wikilink whose label is a bare page reference ("p. 137", "page 12") is dropped.
 *   3. Any other wikilink becomes its label text (real inline terms: "Bonds", "Camp Actions").
 * Trailing "…for details/more information." pointer clauses left behind are then removed.
 */
function stripWikilinks(text) {
	let out = text.replace(/\s*\(\s*\[\[[^\]]*\]\]\s*\)/g, ''); // parenthetical cross-ref
	out = out.replace(/\[\[([^\]]+)\]\]/g, (_, inner) => {
		const [target, label] = inner.split('|');
		const shown = (label ?? (target.includes('#') ? target.slice(target.indexOf('#') + 1) : target)).trim();
		return /^pp?\.?\s*\d|^page\s*\d/i.test(shown) ? '' : shown;
	});
	// Dangling pointer clauses left by cross-refs. A leading `;`/`,` marks a
	// tacked-on pointer ("…(your choice); see Social Encounters…", "…instead of
	// one; for details on Camp Actions."); strip it back to the sentence period.
	// Sentence-start `See "X."` refs (preceded by `.`) are left intact.
	out = out.replace(/\s*[;,]\s*(?:see\s+[^.]*|(?:see\s+)?for (?:details|more)\b[^.]*)(\.)/gi, '$1');
	out = out.replace(/[ \t]*\bSee\s+[A-Z][^."]*\bfor (?:details|more)\b[^.]*\.[ \t]*/g, ' ');
	// Whole pointer sentences ("More information … can be found in X.").
	out = out.replace(/[ \t]*[A-Z][^.]*?\bcan be found\b[^.]*?\.[ \t]*/g, ' ');
	return out;
}

/** All-caps suit-icon alt-text left in the Markdown export (image placeholders), e.g. "Swords SWORDS".
 * Matches the glyph word only (NOT surrounding newlines — eating a `\n\n` here would merge paragraphs). */
const SUIT_GLYPHS = /\b(?:SWORDS|DISKS|PENTACLES|CUPS|BATONS|WANDS)\b/g;

/** A short, non-sentence `####` line is a real sub-heading; a long/sentence one is an emphasized lead paragraph. */
function h4IsHeading(text) {
	const plain = text.replace(/[*_`]/g, '').trim();
	return plain.length <= 55 && !/[.!?:;]$/.test(plain);
}

/**
 * Normalizes a raw Markdown section body into the small dialect the app's
 * renderer understands (paragraphs, `##`/`###` sub-headings, `-` lists,
 * `**bold**`, `*italic*`). Callouts and example sub-sections should already be
 * stripped by the caller.
 */
export function normalizeMarkdown(lines) {
	// 1. Heading normalization, line by line:
	//    - `#####`/`######` are always epigraph quotations (flavor) — drop them
	//      plus an immediately-following `_– attribution_` line.
	//    - `####` is either a real sub-heading (short, title-like) → promote to
	//      `###`, or an emphasized lead paragraph (long/sentence) → demote to plain.
	//    - `##`/`###` are real sub-headings — keep.
	const processed = [];
	for (let i = 0; i < lines.length; i++) {
		const h = parseHeading(lines[i]);
		if (h && h.level >= 5) {
			let attribution = i + 1;
			while (attribution < lines.length && lines[attribution].trim() === '') attribution++;
			if (/^\s*[*_].*[–-].*[*_]\s*$/.test(lines[attribution] ?? '')) i = attribution;
			continue;
		}
		if (h && h.level === 4) {
			processed.push(h4IsHeading(h.text) ? `### ${h.text}` : h.text);
			continue;
		}
		processed.push(lines[i]);
	}

	let text = processed.join('\n');

	text = stripWikilinks(text);
	// Strip inline HTML. Suit-icon images in tables are followed by their visible
	// text labels, so retaining the image alt text would duplicate each heading.
	text = text.replace(/<img\b[^>]*>/gi, '');
	text = text.replace(/<[^>]+>/g, '');
	text = text.replace(/\\([[\]|])/g, '$1'); // unescape \[ \] \|
	text = text.replace(SUIT_GLYPHS, '');
	text = text.replace(/_([^_\n]+)_/g, '*$1*'); // _italic_ -> *italic*
	// A running page header was embedded at the end of one exported table row.
	text = text.replace(/[ \t]*APPENDIX A\s*\|\s*SORCERY\s*\|[ \t]*$/gim, ' |');

	// Bullet indentation ("  - " -> "- "), then strip other leading spaces
	// (e.g. left by glyph removal at line start) and collapse inner runs.
	text = text.replace(/^[ \t]+-\s+/gm, '- ');
	text = text.replace(/^(?!- )[ \t]+/gm, '');
	text = text.replace(/[ \t]{2,}/g, ' ');
	text = text.replace(/[ \t]+$/gm, '');
	text = text.replace(/[ \t]+([.,;:!?])/g, '$1'); // "test of fate ." -> "test of fate."

	// Uniform sub-heading level inside a rule body: the entry title is the h1,
	// so demote any h2 to h3 so all in-body sub-headings render at one level
	// (the source mixes ## and #### for peer sub-headings).
	text = text.replace(/^## (?!#)/gm, '### ');

	// Reflow: the export occasionally leaves a stray newline mid-paragraph. A
	// single newline inside a prose block is a soft break (a space), not a hard
	// `<br>`; join them so each paragraph is one line. Bullet blocks and heading
	// lines keep their line structure.
	text = text
		.split(/\n{2,}/)
		.map((block) => {
			const lines = block.split('\n');
			const structured = lines.some(
				(l) => /^\s*-\s/.test(l) || /^#{1,6}\s/.test(l) || /^\s*\|.*\|\s*$/.test(l)
			);
			return structured ? block : lines.map((l) => l.trim()).filter(Boolean).join(' ');
		})
		.join('\n\n');

	// Collapse 3+ blank lines and trim.
	text = text.replace(/\n{3,}/g, '\n\n').trim();
	return text;
}

/**
 * Full pipeline: extract a section and return clean body markdown for a rule entry.
 *
 * @param {object} [options]
 * @param {boolean} [options.keepCallouts] convert callouts into headings/paragraphs
 *   rather than dropping them (see {@link convertCallouts})
 */
export function extractRuleBody(file, heading, until, after, options = {}) {
	const { lines } = extractSection(file, heading, until, after);
	const decallouted = options.keepCallouts ? convertCallouts(lines) : stripCallouts(lines);
	const clean = normalizeMarkdown(stripExampleSubsections(decallouted));
	return clean;
}

// ---------------------------------------------------------------------------
// Oracle table extraction (campaigns / tarot-procedures.json)
// ---------------------------------------------------------------------------
//
// A separate path from extractRuleBody, for two reasons the rules reference is
// right about and this importer is not:
//   1. stripExampleSubsections drops "Example …" sub-sections — which is where
//      the Meatgrinder and City Events tables live. Extracting them via the
//      rules path yields zero rows.
//   2. stripWikilinks flattens `[[…#Imp|imp]]` to `imp`, destroying the
//      reference target. Here the cross-reference *is* data.
// Neither behaviour is changed; this path simply does not use them.

/**
 * The bracket convention, stated in Ch9's Carouse section (`:275`): "Anything in
 * brackets [ ] refers to the top card of the minor arcana discard pile.
 * Sometimes brackets provide numerical values … Sometimes brackets provide a
 * random result within the table's entry based on the suit of the card."
 *
 * It is **table-scoped**, not global: Meatgrinder and City Events also use
 * brackets, but as category labels ([Curiosity], [Rumor], [Travel event]) keyed
 * to card ranges — nothing to do with the discard pile. A table opts in via the
 * manifest's `bracketConvention`, so a label is never mistyped as a selector.
 */
const BRACKET_RE = /\[([^\]]{1,14})\]/g;
const SUIT_TOKENS = new Set(['swords', 'pentacles', 'cups', 'wands']);

/** Classify one bracket into a typed reference to the minor discard top. */
function parseToken(raw) {
	const text = raw.trim();
	const lower = text.toLowerCase();
	if (lower === 'value') return { kind: 'value' };
	if (lower === 'odd' || lower === 'even') return { kind: 'parity', parity: lower };
	if (SUIT_TOKENS.has(lower)) return { kind: 'suit', suit: lower };
	const range = /^(\S+)\s*[–—-]\s*(\S+)$/.exec(text);
	if (range) return { kind: 'range', from: range[1], to: range[2] };
	// A bare numeral/court rank is a one-card range.
	if (/^(?:[IVXL]+|\d+|Page|Knight|Queen|King)$/i.test(text)) {
		return { kind: 'range', from: text, to: text };
	}
	return null;
}

/**
 * The book names the four minor court ranks two ways: by name in most tables
 * (Maleficence, Malediction, Random Totem, We're Doomed …) and as Roman numerals
 * XI–XIV in Signs and Portents, consistent with Ch7's "the minor arcana … are
 * also rated from 1–14". Keys are structured data, not prose, so they are
 * normalized to one notation; the cell text stays verbatim and `source` still
 * points at the original.
 */
const MINOR_COURT_BY_NUMERAL = new Map([
	['XI', 'Page'],
	['XII', 'Knight'],
	['XIII', 'Queen'],
	['XIV', 'King']
]);

function normalizeMinorKey(key) {
	return MINOR_COURT_BY_NUMERAL.get(key) ?? key;
}

/** `I–VII` (en-dash) or `I-VII` -> {from:'I',to:'VII'}; `I` -> {from:'I',to:'I'}. */
export function parseCardKey(raw) {
	const text = raw
		.replace(/<[^>]+>/g, '')
		.replace(/[*_`]/g, '')
		.trim();
	const m = /^(\S+)\s*[–—-]\s*(\S+)$/.exec(text);
	return m
		? { kind: 'card-range', from: m[1], to: m[2] }
		: { kind: 'card-range', from: text, to: text };
}

/** Header cells carry the suit as `<img alt="swords">` followed by the label. */
function headerLabel(cell) {
	const alt = /<img\b[^>]*\balt="([^"]*)"/i.exec(cell);
	const text = cell
		.replace(/<[^>]+>/g, '')
		.replace(/[*_`]/g, '')
		.trim();
	if (text) return text;
	return alt ? alt[1].trim() : '';
}

/**
 * Splits a table row on `|`, ignoring pipes inside a wikilink. The vault writes
 * `[[13 - Appendix C - Dungeon Denizens#Imp|imp]]` unescaped inside table cells,
 * so a naive split on `|` shatters the cell and loses the reference.
 */
function splitRow(line) {
	const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
	const cells = [];
	let current = '';
	let depth = 0;
	for (let i = 0; i < inner.length; i++) {
		if (inner.startsWith('[[', i)) depth++;
		else if (inner.startsWith(']]', i) && depth > 0) depth--;
		if (inner[i] === '|' && depth === 0) {
			cells.push(current);
			current = '';
			continue;
		}
		current += inner[i];
	}
	cells.push(current);
	return cells;
}

const DELIMITER_CELL = /^\s*:?-{3,}:?\s*$/;

/** Content ids are kebab-cased headings, matching the pack's existing convention. */
function slugify(text) {
	return text
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');
}

/**
 * Parses one cell: wikilinks become typed references, `<br>` becomes a space,
 * and brackets become typed discard-top tokens when the table opts in.
 *
 * @param {boolean} bracketsAreTokens whether this table declares the Ch9
 *   discard-top bracket convention. When false, brackets are left as prose —
 *   City Events' `[Curiosity]` is a category label, not a selector.
 */
function parseCellText(raw, bracketsAreTokens) {
	const references = [];
	let text = raw.replace(/\[\[([^\]]+)\]\]/g, (_, inner) => {
		const [target, label] = inner.split('|');
		const shown = (label ?? target).trim();
		const hash = target.indexOf('#');
		const entry = hash === -1 ? target : target.slice(hash + 1);
		const collection = /Dungeon Denizens/i.test(target)
			? 'denizens'
			: /Alchemy/i.test(target)
				? 'alchemy'
				: 'rules';
		references.push({ collection, entryId: slugify(entry), label: shown });
		return shown;
	});
	text = text
		// `<br>` separates clauses in the source ("… on your face.<br>• It is: …").
		// Dropping it without a space welds the clauses together.
		.replace(/<br\s*\/?>/gi, ' ')
		.replace(/<[^>]+>/g, '')
		.replace(/\\([[\]|])/g, '$1')
		.replace(/_([^_\n]+)_/g, '*$1*')
		.replace(/\s+/g, ' ')
		.trim();

	const tokens = [];
	if (bracketsAreTokens) {
		for (const m of text.matchAll(BRACKET_RE)) {
			const token = parseToken(m[1]);
			if (!token) {
				throw new Error(
					`unrecognized bracket ${JSON.stringify(m[0])} in a table declaring the discard-top convention`
				);
			}
			tokens.push(token);
		}
	}
	return { text, tokens, references };
}

const SUIT_BY_LABEL = new Map([
	['swords', 'swords'],
	['cups', 'cups'],
	['pentacles', 'pentacles'],
	['wands', 'wands']
]);

/**
 * Verifies a manifest-declared deck against the table's keys. Inference alone is
 * unsafe: the book writes minor values as Roman numerals in some tables (Ch7 —
 * "the minor arcana … are also rated from 1–14"), so keys I–XIV are consistent
 * with *either* deck. Only two signals are decisive, and each is checked rather
 * than guessed:
 *   - a court rank (Page/Knight/Queen/King) can only be minor
 *   - XV–XXI can only be major
 * Anything else is undecidable from the keys, so the manifest's declaration
 * stands and the lookup-coverage test is what proves it right.
 */
function verifyDeck(rows, axis, declared) {
	if (axis === 'suit-by-step') return declared;
	const keys = rows.flatMap((r) => (r.key.kind === 'card-range' ? [r.key.from, r.key.to] : []));
	const court = keys.find((k) => /^(Page|Knight|Queen|King)$/i.test(k));
	const highMajor = keys.find((k) => /^(XV|XVI|XVII|XVIII|XIX|XX|XXI)$/.test(k));
	if (court && declared !== 'minor') {
		throw new Error(`declared deck "${declared}" but key ${JSON.stringify(court)} is minor-only`);
	}
	if (highMajor && declared !== 'major') {
		throw new Error(
			`declared deck "${declared}" but key ${JSON.stringify(highMajor)} is major-only`
		);
	}
	return declared;
}

/**
 * Extracts the first pipe table inside a section (or after a bullet anchor) as
 * structured rows. Source order is the table's order; nothing is sorted.
 *
 * @param {string} file chapter filename under MD_DIR
 * @param {string} [heading] section heading; omit when using `options.anchor`
 * @param {string} [after] landmark heading, to disambiguate a repeated `heading`
 * @param {object} [options]
 * @param {string} [options.anchor] exact leading text of a bullet item — for the
 *   Appendix D Special City Actions, which have no heading of their own
 * @param {'major'|'minor'} options.deck required; verified against the keys
 * @param {boolean} [options.bracketConvention] the table declares Ch9's
 *   discard-top bracket convention, so brackets parse into typed tokens
 */
export function extractTable(file, heading, after, options = {}) {
	let lines;
	if (options.anchor) {
		const raw = readFileSync(join(MD_DIR, file), 'utf8').split('\n');
		const start = raw.findIndex((l) => l.trimStart().startsWith(options.anchor));
		if (start === -1) {
			throw new Error(`anchor not found in ${file}: ${JSON.stringify(options.anchor)}`);
		}
		const end = raw.findIndex((l, i) => i > start && /^#{1,6}\s/.test(l));
		lines = raw.slice(start, end === -1 ? raw.length : end);
	} else {
		lines = extractSection(file, heading, undefined, after).lines;
	}

	const first = lines.findIndex((l) => /^\s*\|.*\|\s*$/.test(l));
	if (first === -1) {
		throw new Error(`no table found in ${file} at ${JSON.stringify(options.anchor ?? heading)}`);
	}
	let last = first;
	while (last + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[last + 1])) last++;
	// The export baked a running page header into the end of at least one table
	// row ("… APPENDIX A | SORCERY |" on Malediction's King). normalizeMarkdown
	// strips it for the rules path; do the same here, before splitting on pipes,
	// or it becomes a phantom extra cell.
	const block = lines
		.slice(first, last + 1)
		.map((l) => l.replace(/[ \t]*APPENDIX [A-E]\s*\|\s*[A-Z ]+\s*\|[ \t]*$/i, ' |'));

	const header = splitRow(block[0]).map(headerLabel);
	const bodyRows = block.slice(1).filter((l) => !splitRow(l).every((c) => DELIMITER_CELL.test(c)));

	// Column 0 is the key; the rest are value columns.
	const valueLabels = header.slice(1);
	const suitColumns =
		valueLabels.length > 1 && valueLabels.every((l) => SUIT_BY_LABEL.has(l.toLowerCase()));
	const keyIsSuit = /^suit$/i.test(header[0]);
	const axis = keyIsSuit ? 'suit-by-step' : suitColumns ? 'card-by-suit' : 'card';

	const columns = valueLabels.map((label, i) => ({
		id: suitColumns ? SUIT_BY_LABEL.get(label.toLowerCase()) : keyIsSuit ? `step-${i + 1}` : 'result',
		label
	}));

	const deck = options.deck;
	const rows = bodyRows.map((line) => {
		const cells = splitRow(line);
		let key;
		if (keyIsSuit) {
			key = { kind: 'suit', suit: SUIT_BY_LABEL.get(headerLabel(cells[0]).toLowerCase()) };
		} else {
			key = parseCardKey(cells[0]);
			if (deck === 'minor') {
				key = { ...key, from: normalizeMinorKey(key.from), to: normalizeMinorKey(key.to) };
			}
		}
		return {
			key,
			cells: cells.slice(1).map((cell, i) => ({
				columnId: columns[i]?.id ?? `col-${i}`,
				...parseCellText(cell, Boolean(options.bracketConvention))
			}))
		};
	});

	if (!options.deck) {
		throw new Error(`extractTable requires options.deck for ${JSON.stringify(heading ?? options.anchor)}`);
	}
	return { deck: verifyDeck(rows, axis, options.deck), axis, columns, rows };
}
