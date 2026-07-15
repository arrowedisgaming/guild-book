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
