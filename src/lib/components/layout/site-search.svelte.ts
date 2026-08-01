import {
	getRulesSearch,
	hitHref,
	type RuleSearchHit,
	type RulesSearchEngine
} from '$lib/search/rules-search';

export type SiteSearchStatus = 'idle' | 'loading' | 'ready' | 'error';

const MAX_HITS = 15;

/**
 * Headless combobox state for the header rules search. The component renders
 * it; keyboard semantics live here so they are unit-testable. onKeydown
 * returns the href to navigate to (Enter on an active option) or null.
 */
export function createSiteSearch(packVersion: string, deps: { getEngine?: typeof getRulesSearch } = {}) {
	const getEngine = deps.getEngine ?? getRulesSearch;
	let engine: RulesSearchEngine | null = null;
	let query = $state('');
	let open = $state(false);
	let active = $state(-1);
	let status = $state<SiteSearchStatus>('idle');
	let hits = $state<RuleSearchHit[]>([]);
	let composing = false;

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

	function close() {
		open = false;
		active = -1;
	}

	return {
		get query() {
			return query;
		},
		get open() {
			return open;
		},
		get active() {
			return active;
		},
		get status() {
			return status;
		},
		get hits() {
			return hits;
		},
		onFocus() {
			if (status === 'error') status = 'idle';
			void ensureEngine();
			if (query.trim()) open = true;
		},
		onInput(value: string) {
			query = value;
			open = true;
			void ensureEngine();
			runSearch();
		},
		setComposing(v: boolean) {
			composing = v;
		},
		close,
		onKeydown(e: KeyboardEvent): string | null {
			if (e.key === 'Escape') {
				close();
				return null;
			}
			if (!open || hits.length === 0) return null;
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				active = Math.min(active + 1, hits.length - 1);
				return null;
			}
			if (e.key === 'ArrowUp') {
				e.preventDefault();
				active = Math.max(active - 1, 0);
				return null;
			}
			if (e.key === 'Enter' && !composing && active >= 0) {
				e.preventDefault();
				const hit = hits[active];
				close();
				return hitHref(hit);
			}
			return null;
		}
	};
}
