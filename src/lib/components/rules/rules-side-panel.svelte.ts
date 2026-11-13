import { getRulesSearch, type RuleSearchHit, type RulesSearchEngine } from '$lib/search/rules-search';
import type { SiteSearchStatus } from '$lib/components/layout/site-search.svelte';
import type { RuleEntry } from '$lib/types/content-pack';

export type RuleLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

const MAX_HITS = 15;

/**
 * Headless state for the rules side panel: search, open a rule, back to
 * results, keyboard handling. The component renders it. Rule loads are
 * guarded by a request counter so a slow earlier load (or one superseded by
 * typing / going back) never overwrites newer state.
 */
export function createRulesSidePanel(
	packVersion: string,
	deps: {
		getEngine?: typeof getRulesSearch;
		fetchRule?: (id: string) => Promise<RuleEntry>;
	} = {}
) {
	const getEngine = deps.getEngine ?? getRulesSearch;
	const fetchRule =
		deps.fetchRule ??
		(async (id: string): Promise<RuleEntry> => {
			const res = await fetch(`/api/rules/${encodeURIComponent(id)}?v=${packVersion}`);
			if (!res.ok) throw new Error(`rule ${id}: ${res.status}`);
			const body = (await res.json()) as { rule: RuleEntry };
			return body.rule;
		});

	let engine: RulesSearchEngine | null = null;
	let query = $state('');
	let active = $state(-1);
	let status = $state<SiteSearchStatus>('idle');
	let hits = $state<RuleSearchHit[]>([]);
	let view = $state<'search' | 'rule'>('search');
	let rule = $state<RuleEntry | null>(null);
	let ruleStatus = $state<RuleLoadStatus>('idle');
	let ruleId = $state<string | null>(null);
	let ruleSection = $state<string | null>(null);
	let phrase = $state<string | null>(null);
	let composing = false;
	let requestSeq = 0;

	async function ensureEngine() {
		if (engine || status === 'loading') return;
		status = 'loading';
		try {
			engine = await getEngine(packVersion);
			status = 'ready';
			runSearch();
		} catch {
			status = 'error';
		}
	}

	function runSearch() {
		if (!engine) return;
		hits = engine.search(query).slice(0, MAX_HITS);
		active = hits.length ? 0 : -1;
	}

	async function load(
		id: string,
		section: string | null,
		hitPhrase: string | null,
		fallbackSection: string | null = null
	) {
		const seq = ++requestSeq;
		view = 'rule';
		ruleId = id;
		ruleSection = section;
		phrase = hitPhrase;
		rule = null;
		ruleStatus = 'loading';
		try {
			const loaded = await fetchRule(id);
			if (seq !== requestSeq) return;
			rule = loaded;
			if (section === null) ruleSection = loaded.section ?? null;
			ruleStatus = 'ready';
		} catch {
			if (seq !== requestSeq) return;
			if (section === null) ruleSection = fallbackSection;
			ruleStatus = 'error';
		}
	}

	function backToResults() {
		requestSeq++;
		view = 'search';
	}

	return {
		get query() {
			return query;
		},
		get status() {
			return status;
		},
		get hits() {
			return hits;
		},
		get active() {
			return active;
		},
		get view() {
			return view;
		},
		get rule() {
			return rule;
		},
		get ruleStatus() {
			return ruleStatus;
		},
		get ruleId() {
			return ruleId;
		},
		get ruleSection() {
			return ruleSection;
		},
		get phrase() {
			return phrase;
		},
		onFocus() {
			if (status === 'error') status = 'idle';
			void ensureEngine();
		},
		onInput(value: string) {
			query = value;
			backToResults();
			void ensureEngine();
			runSearch();
		},
		setComposing(v: boolean) {
			composing = v;
		},
		onKeydown(e: KeyboardEvent) {
			if (e.key === 'Escape') {
				if (view === 'rule') {
					e.preventDefault();
					backToResults();
				}
				return;
			}
			if (view !== 'search' || hits.length === 0) return;
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				active = Math.min(active + 1, hits.length - 1);
			} else if (e.key === 'ArrowUp') {
				e.preventDefault();
				active = Math.max(active - 1, 0);
			} else if (e.key === 'Enter' && !composing && active >= 0) {
				e.preventDefault();
				void load(hits[active].doc.id, hits[active].doc.section, hits[active].phrase);
			}
		},
		async openHit(index: number) {
			const hit = hits[index];
			if (!hit) return;
			active = index;
			await load(hit.doc.id, hit.doc.section, hit.phrase);
		},
		async openRuleById(id: string) {
			const known = engine?.docs.find((d) => d.id === id)?.section ?? null;
			await load(id, null, null, known);
		},
		backToResults
	};
}
