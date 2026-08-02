/**
 * Pure phrase-location over a list of text-node strings, so the DOM highlighter
 * can find "the literal phrase the user searched" inside a rendered article
 * even when inline markup (<strong>, <em>) splits it across text nodes, the
 * page uses typographic apostrophes, or whitespace differs. Folding rules
 * mirror the search engine's: case-insensitive, straight/curly apostrophes and
 * double quotes ignored, whitespace runs collapse to one space.
 */

export interface NodeMatch {
	nodeIndex: number;
	/** Start offset within the node's text (inclusive). */
	start: number;
	/** End offset within the node's text (exclusive). */
	end: number;
}

const DOUBLE_QUOTES = /["“”„]/g;
const APOSTROPHES = /[’‘']/g;

/** Query-side folding: what the user typed, normalized for phrase comparison. */
export function foldQueryPhrase(s: string): string {
	return s
		.toLowerCase()
		.replace(DOUBLE_QUOTES, '')
		.replace(APOSTROPHES, '')
		.replace(/\s+/g, ' ')
		.trim();
}

const SKIP_CHAR = /["“”„’‘']/;

/**
 * Finds the first occurrence of `phrase` (folded) across `nodeTexts` (folded
 * the same way, built with an origin map). Returns per-node ranges covering
 * the match in the ORIGINAL texts, or null if absent.
 */
export function findFoldedPhrase(nodeTexts: string[], phrase: string): NodeMatch[] | null {
	const target = foldQueryPhrase(phrase);
	if (!target) return null;

	let stream = '';
	const origins: Array<{ node: number; offset: number }> = [];
	let lastWasSpace = true;
	for (let n = 0; n < nodeTexts.length; n++) {
		const text = nodeTexts[n];
		for (let i = 0; i < text.length; i++) {
			const ch = text[i];
			if (SKIP_CHAR.test(ch)) continue;
			if (/\s/.test(ch)) {
				if (lastWasSpace) continue;
				stream += ' ';
				origins.push({ node: n, offset: i });
				lastWasSpace = true;
				continue;
			}
			stream += ch.toLowerCase();
			origins.push({ node: n, offset: i });
			lastWasSpace = false;
		}
	}

	const at = stream.indexOf(target);
	if (at === -1) return null;
	const startOrigin = origins[at];
	const endOrigin = origins[at + target.length - 1];

	const matches: NodeMatch[] = [];
	for (let n = startOrigin.node; n <= endOrigin.node; n++) {
		const start = n === startOrigin.node ? startOrigin.offset : 0;
		const end = n === endOrigin.node ? endOrigin.offset + 1 : nodeTexts[n].length;
		if (end > start) matches.push({ nodeIndex: n, start, end });
	}
	return matches;
}
