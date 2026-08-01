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
}

export interface RulesSearchEngine {
	docs: RuleSearchDoc[];
	search(query: string): RuleSearchHit[];
}

/** Case + straight/curly apostrophe folding, shared with snippet highlighting. */
export const foldText = (s: string): string => s.toLowerCase().replace(/[’‘']/g, '');

export const tokenize = (s: string): string[] =>
	foldText(s)
		.split(/[^\p{L}\p{N}]+/u)
		.filter((t) => t.length > 0);

const ARTIFACT_PATH = '/content-packs/hmtw/rules-search.json';
const EXACT_TITLE_BONUS = 100;

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
			if (tokenize(query).join('').length < 2) return [];
			const folded = foldText(query.trim());
			const hits = mini.search(query).map((r) => {
				const { doc, bookIndex } = byId.get(String(r.id))!;
				const bonus = foldText(doc.title) === folded ? EXACT_TITLE_BONUS : 0;
				return { doc, bookIndex, terms: r.terms, score: r.score + bonus };
			});
			hits.sort((a, b) => b.score - a.score || a.bookIndex - b.bookIndex);
			return hits;
		}
	};
}
