/**
 * Truncate a (possibly multi-paragraph markdown) string to about `maxWords`
 * words, ending on a sentence boundary so the blurb never cuts mid-thought.
 *
 * Walks word by word; once past `maxWords`, stops at the next sentence-ending
 * punctuation. If the whole text is already within budget it is returned as-is.
 * A trailing "…" is appended only when text was actually dropped and the cut
 * point wasn't itself a sentence end.
 */
export function truncateAtSentence(text: string, maxWords = 100): string {
	const trimmed = text.trim();
	const words = trimmed.split(/\s+/);
	if (words.length <= maxWords) return trimmed;

	const endsSentence = (w: string) => /[.!?][")'”’\]]?$/.test(w);

	// Accumulate up to the budget, then stop at the next sentence end.
	const kept: string[] = [];
	for (let i = 0; i < words.length; i++) {
		kept.push(words[i]);
		if (kept.length >= maxWords && endsSentence(words[i])) return kept.join(' ');
	}

	// No sentence end reachable past the budget — hard-cut with an ellipsis.
	return words.slice(0, maxWords).join(' ').replace(/[,;:—-]$/, '') + '…';
}

/**
 * Remove the final complete sentence from a prose excerpt. The remaining text
 * is returned verbatim apart from surrounding whitespace. Short, single-
 * sentence excerpts are left alone so a description never disappears.
 */
export function dropLastSentence(text: string): string {
	const trimmed = text.trim();
	const boundaries = [...trimmed.matchAll(/[.!?]+[\")'\]”’]*(?=\s|$)/g)];
	if (boundaries.length < 2) return trimmed;

	const previousEnd = (boundaries.at(-2)?.index ?? 0) + (boundaries.at(-2)?.[0].length ?? 0);
	return trimmed.slice(0, previousEnd).trimEnd();
}

/**
 * Use the first Markdown paragraph as an introduction and shorten it by one
 * complete sentence. The full source text can then remain available separately.
 */
export function shortenedIntroduction(text: string): string {
	const firstParagraph = text.trim().split(/\n{2,}/, 1)[0] ?? '';
	return dropLastSentence(firstParagraph);
}

/**
 * Add presentation-only paragraph breaks to a long prose block without
 * changing its words. Existing markdown paragraphs and non-prose blocks are
 * retained; only long single paragraphs are regrouped.
 */
export function paragraphizeSentences(text: string, sentencesPerParagraph = 3): string {
	if (sentencesPerParagraph < 1) return text;

	return text
		.split(/\n{2,}/)
		.map((block) => {
			const trimmed = block.trim();
			if (!trimmed || /^(?:#{2,6}\s|\s*-\s+)/m.test(trimmed)) return block;

			const sentences = trimmed.match(/.*?[.!?]+[\")'\]”’]*(?=\s|$)|.+$/g);
			if (!sentences || sentences.length <= sentencesPerParagraph) return trimmed;

			const paragraphs: string[] = [];
			for (let i = 0; i < sentences.length; i += sentencesPerParagraph) {
				paragraphs.push(sentences.slice(i, i + sentencesPerParagraph).map((s) => s.trim()).join(' '));
			}
			return paragraphs.join('\n\n');
		})
		.join('\n\n');
}
