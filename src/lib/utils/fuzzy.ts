/**
 * Fuzzy matching for the type-to-filter pickers. A query matches when its
 * letters appear in the text in order; closer, earlier and word-initial
 * matches rank higher, and an exact or prefix match always beats a scattered
 * one. Pure: no DOM, no state.
 */

const normalise = (value: string) =>
	value
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();

/** A score for ranking (higher is better), or null when the query does not match. */
export function fuzzyScore(query: string, text: string): number | null {
	const q = normalise(query);
	const t = normalise(text);
	if (!q) return 0;
	if (t === q) return 1000;
	if (t.startsWith(q)) return 900 - t.length;
	const at = t.indexOf(q);
	if (at >= 0) return (t[at - 1] === ' ' ? 800 : 700) - at - t.length / 10;

	// In-order letters, ignoring the spaces in the query ("shl" finds "Shield, Light").
	const letters = q.replace(/ /g, '');
	let from = 0;
	let previous = -2;
	let score = 100;
	for (const letter of letters) {
		const found = t.indexOf(letter, from);
		if (found < 0) return null;
		if (found === previous + 1) score += 12;
		else if (found === 0 || t[found - 1] === ' ') score += 9;
		else score -= Math.min(6, found - from);
		previous = found;
		from = found + 1;
	}
	return score - t.length / 10;
}

/** The items that match, best first; every item, in its own order, for an empty query. */
export function fuzzyFilter<T>(query: string, items: readonly T[], text: (item: T) => string): T[] {
	if (!normalise(query)) return [...items];
	return items
		.map((item, index) => ({ item, index, score: fuzzyScore(query, text(item)) }))
		.filter((entry): entry is { item: T; index: number; score: number } => entry.score !== null)
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.map((entry) => entry.item);
}
