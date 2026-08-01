import type { RuleSearchDoc } from '$lib/types/content-pack';

/**
 * Client-side rules search: one memoized engine per session, built from the
 * static, digest-verified rules-search.json. MiniSearch is dynamically
 * imported so no page pays for it until search is actually used. Failed
 * initialization clears the memo so the next interaction retries.
 */

export interface RuleSearchHit {
	doc: RuleSearchDoc;
	score: number;
	/** Index terms the engine matched — the source of truth for highlighting
	 * (a fuzzy hit for "challnge" reports "challenge"). */
	terms: string[];
	bookIndex: number;
	/** The cleaned query when it occurs verbatim in this doc (title, heading,
	 * or body) — drives phrase snippets and the ?hl= deep link. Null when the
	 * doc matched on scattered terms only. */
	phrase: string | null;
}

export interface RulesSearchEngine {
	docs: RuleSearchDoc[];
	search(query: string): RuleSearchHit[];
}

/** Case + straight/curly apostrophe folding, shared with snippet highlighting. */
export const foldText = (s: string): string => s.toLowerCase().replace(/[’‘']/g, '');

/** Double quotes (straight or typographic) are tolerated, never operators:
 * they're stripped before matching, so "dealing with traps" ≡ dealing with traps. */
export const cleanQuery = (s: string): string =>
	s
		.replace(/["“”„]/g, '')
		.replace(/\s+/g, ' ')
		.trim();

/** Phrase-comparison folding: foldText plus whitespace collapse, so a phrase
 * matches across the artifact's line breaks. */
const foldPhrase = (s: string): string => foldText(s).replace(/\s+/g, ' ');

/** Where a result links: the section page anchored to the entry, carrying the
 * matched phrase for in-page scroll-and-highlight when there is one. */
export function hitHref(hit: RuleSearchHit): string {
	const hl = hit.phrase ? `?hl=${encodeURIComponent(hit.phrase)}` : '';
	return `/rules/${hit.doc.section}${hl}#${hit.doc.id}`;
}

export const tokenize = (s: string): string[] =>
	foldText(s)
		.split(/[^\p{L}\p{N}]+/u)
		.filter((t) => t.length > 0);

const ARTIFACT_PATH = '/content-packs/hmtw/rules-search.json';
const EXACT_TITLE_BONUS = 100;
/** A verbatim phrase occurrence outranks any scattered-terms match; where it
 * occurs tiers the boost the same way field boosts do. */
const PHRASE_BONUS = { title: 90, headings: 70, body: 50 } as const;

let memo: Promise<RulesSearchEngine> | null = null;

export function getRulesSearch(packVersion: string, fetchFn: typeof fetch = fetch): Promise<RulesSearchEngine> {
	if (!memo) {
		memo = build(packVersion, fetchFn).catch((err) => {
			memo = null;
			throw err;
		});
	}
	return memo;
}

export function resetRulesSearchForTests(): void {
	memo = null;
}

async function build(packVersion: string, fetchFn: typeof fetch): Promise<RulesSearchEngine> {
	const res = await fetchFn(`${ARTIFACT_PATH}?v=${encodeURIComponent(packVersion)}`);
	if (!res.ok) throw new Error(`rules search index fetch failed: ${res.status}`);
	const docs = (await res.json()) as RuleSearchDoc[];
	const { default: MiniSearch } = await import('minisearch');

	const mini = new MiniSearch<RuleSearchDoc>({
		fields: ['title', 'headings', 'body'],
		storeFields: [],
		tokenize,
		extractField: (doc, field) =>
			field === 'headings' ? doc.headings.join('\n') : String(doc[field as keyof RuleSearchDoc] ?? ''),
		searchOptions: {
			boost: { title: 4, headings: 2 },
			prefix: true,
			fuzzy: 0.2,
			combineWith: 'AND'
		}
	});
	mini.addAll(docs);
	const byId = new Map(docs.map((d, i) => [d.id, { doc: d, bookIndex: i }]));

	return {
		docs,
		search(query: string): RuleSearchHit[] {
			const cleaned = cleanQuery(query);
			if (tokenize(cleaned).join('').length < 2) return [];
			const folded = foldPhrase(cleaned);
			const multiTerm = tokenize(cleaned).length > 1;
			const hits = mini.search(cleaned).map((r) => {
				const { doc, bookIndex } = byId.get(String(r.id))!;
				let bonus = foldText(doc.title) === folded ? EXACT_TITLE_BONUS : 0;
				let phrase: string | null = null;
				if (multiTerm) {
					if (foldPhrase(doc.title).includes(folded)) {
						bonus += PHRASE_BONUS.title;
						phrase = cleaned;
					} else if (doc.headings.some((h) => foldPhrase(h).includes(folded))) {
						bonus += PHRASE_BONUS.headings;
						phrase = cleaned;
					} else if (foldPhrase(doc.body).includes(folded)) {
						bonus += PHRASE_BONUS.body;
						phrase = cleaned;
					}
				}
				return { doc, bookIndex, terms: r.terms, phrase, score: r.score + bonus };
			});
			// Phrase presence is the PRIMARY key — a verbatim occurrence always
			// outranks scattered-term matches regardless of raw term-frequency
			// score (which is unbounded and could otherwise swamp a flat bonus).
			hits.sort(
				(a, b) =>
					Number(b.phrase !== null) - Number(a.phrase !== null) ||
					b.score - a.score ||
					a.bookIndex - b.bookIndex
			);
			return hits;
		}
	};
}
