/**
 * DOM half of phrase highlighting: walks an article's text nodes, locates the
 * searched phrase via the pure findFoldedPhrase, and wraps the match in
 * <mark class="phrase-hl"> elements (one per intersected text node). Browser
 * only — exercised by the Playwright suite; the location logic itself is
 * unit-tested in find-in-text.
 */

import { findFoldedPhrase } from './find-in-text';

const MARK_CLASS = 'phrase-hl';

/** Unwraps every previously-inserted phrase mark (idempotent). */
export function clearPhraseHighlights(root: ParentNode = document): void {
	for (const mark of root.querySelectorAll(`mark.${MARK_CLASS}`)) {
		const parent = mark.parentNode;
		if (!parent) continue;
		while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
		parent.removeChild(mark);
		if (parent instanceof Element || parent instanceof Document) parent.normalize();
	}
}

/**
 * Highlights the first occurrence of `phrase` inside `root`. Returns the
 * first <mark> (the scroll target) or null when the phrase isn't found.
 */
export function highlightPhrase(root: HTMLElement, phrase: string): HTMLElement | null {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const nodes: Text[] = [];
	let current: Node | null;
	while ((current = walker.nextNode())) nodes.push(current as Text);

	const match = findFoldedPhrase(
		nodes.map((n) => n.data),
		phrase
	);
	if (!match) return null;

	// Wrap back-to-front so earlier offsets stay valid while nodes are split.
	let firstMark: HTMLElement | null = null;
	for (let i = match.length - 1; i >= 0; i--) {
		const { nodeIndex, start, end } = match[i];
		const range = document.createRange();
		range.setStart(nodes[nodeIndex], start);
		range.setEnd(nodes[nodeIndex], end);
		const mark = document.createElement('mark');
		mark.className = MARK_CLASS;
		range.surroundContents(mark);
		firstMark = mark;
	}
	return firstMark;
}
