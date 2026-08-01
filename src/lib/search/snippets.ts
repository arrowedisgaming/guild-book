/**
 * Snippet + highlight construction for search results. Output is a list of
 * {text, marked} parts rendered as text nodes around <mark> elements — no
 * HTML strings, so query-derived content can never inject markup. Terms come
 * from the engine's match metadata (already folded), so fuzzy hits highlight
 * the matched word, not the typo the user typed.
 */

export interface SnippetPart {
	text: string;
	marked: boolean;
}

/** Regex path, exported on its own so the non-Segmenter branch stays tested. */
export function splitSentencesFallback(text: string): string[] {
	return text
		.split(/(?<=[.!?])\s+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

export function splitSentences(text: string): string[] {
	if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
		const seg = new Intl.Segmenter('en', { granularity: 'sentence' });
		return [...seg.segment(text)].map((s) => s.segment.trim()).filter(Boolean);
	}
	return splitSentencesFallback(text);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A term regex tolerant of apostrophes between letters ("deaths" ⇢ "Death's"). */
function termRegex(term: string): RegExp {
	const pattern = term.split('').map(escapeRe).join('[’‘\']?');
	return new RegExp(pattern, 'gi');
}

export function markParts(text: string, terms: string[]): SnippetPart[] {
	const ranges: Array<[number, number]> = [];
	for (const term of terms.filter(Boolean)) {
		for (const m of text.matchAll(termRegex(term))) {
			if (m[0]) ranges.push([m.index, m.index + m[0].length]);
		}
	}
	ranges.sort((a, b) => a[0] - b[0]);
	const merged: Array<[number, number]> = [];
	for (const r of ranges) {
		const last = merged[merged.length - 1];
		if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
		else merged.push([r[0], r[1]]);
	}
	const parts: SnippetPart[] = [];
	let pos = 0;
	for (const [start, end] of merged) {
		if (start > pos) parts.push({ text: text.slice(pos, start), marked: false });
		parts.push({ text: text.slice(start, end), marked: true });
		pos = end;
	}
	if (pos < text.length) parts.push({ text: text.slice(pos), marked: false });
	return parts.length ? parts : [{ text, marked: false }];
}

export function buildSnippet(body: string, terms: string[], contextChars = 220): SnippetPart[] {
	const sentences = splitSentences(body);
	const hit = sentences.find((s) => terms.some((t) => t && termRegex(t).test(s)));
	const window = (hit ?? body.slice(0, contextChars)).slice(0, contextChars * 2);
	return markParts(window, terms);
}
