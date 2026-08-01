import { describe, expect, it, vi } from 'vitest';
import { createSiteSearch } from '$lib/components/layout/site-search.svelte';
import type { RulesSearchEngine } from '$lib/search/rules-search';

const engine: RulesSearchEngine = {
	docs: [],
	search: (q: string) =>
		q.includes('challenge')
			? [
					{ doc: { id: 'challenge-sequence', section: 'challenge-phase', title: 'Flow', headings: [], body: 'b' }, score: 2, terms: ['challenge'], bookIndex: 0 },
					{ doc: { id: 'challenge-guard', section: 'challenge-phase', title: 'Guard', headings: [], body: 'b' }, score: 1, terms: ['challenge'], bookIndex: 1 }
				]
			: []
};

// vitest runs this suite under the `node` environment (see vitest.config.ts),
// which has no `KeyboardEvent` global (Node only ships `Event`/`CustomEvent`).
// A minimal duck-typed fake stands in — it carries the `.key` and
// `.preventDefault()` shape `onKeydown` actually reads — rather than pulling
// in jsdom/happy-dom for the whole suite.
const key = (k: string) => ({ key: k, preventDefault: () => {} }) as KeyboardEvent;

describe('createSiteSearch', () => {
	it('loads the engine on first focus and becomes ready', async () => {
		const getEngine = vi.fn(async () => engine);
		const s = createSiteSearch('4.0.0', { getEngine });
		expect(s.status).toBe('idle');
		s.onFocus();
		expect(s.status).toBe('loading');
		await vi.waitFor(() => expect(s.status).toBe('ready'));
		expect(getEngine).toHaveBeenCalledWith('4.0.0');
	});

	it('reports error status on failure, and refocusing retries', async () => {
		const getEngine = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(engine);
		const s = createSiteSearch('4.0.0', { getEngine });
		s.onFocus();
		await vi.waitFor(() => expect(s.status).toBe('error'));
		s.onFocus();
		await vi.waitFor(() => expect(s.status).toBe('ready'));
	});

	it('searches on input, opens the listbox, and activates the first hit', async () => {
		const s = createSiteSearch('4.0.0', { getEngine: async () => engine });
		s.onFocus();
		await vi.waitFor(() => expect(s.status).toBe('ready'));
		s.onInput('challenge');
		expect(s.open).toBe(true);
		expect(s.hits.map((h) => h.doc.id)).toEqual(['challenge-sequence', 'challenge-guard']);
		expect(s.active).toBe(0);
	});

	it('arrows move the active option; Enter returns the target href; Esc closes', async () => {
		const s = createSiteSearch('4.0.0', { getEngine: async () => engine });
		s.onFocus();
		await vi.waitFor(() => expect(s.status).toBe('ready'));
		s.onInput('challenge');
		expect(s.onKeydown(key('ArrowDown'))).toBeNull();
		expect(s.active).toBe(1);
		expect(s.onKeydown(key('Enter'))).toBe('/rules/challenge-phase#challenge-guard');
		s.onInput('challenge');
		expect(s.onKeydown(key('Escape'))).toBeNull();
		expect(s.open).toBe(false);
	});

	it('Enter during IME composition does not navigate', async () => {
		const s = createSiteSearch('4.0.0', { getEngine: async () => engine });
		s.onFocus();
		await vi.waitFor(() => expect(s.status).toBe('ready'));
		s.onInput('challenge');
		s.setComposing(true);
		expect(s.onKeydown(key('Enter'))).toBeNull();
	});
});
