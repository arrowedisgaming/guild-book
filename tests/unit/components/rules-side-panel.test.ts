import { describe, expect, it, vi } from 'vitest';
import { createRulesSidePanel } from '$lib/components/rules/rules-side-panel.svelte';
import type { RulesSearchEngine } from '$lib/search/rules-search';
import type { RuleEntry } from '$lib/types/content-pack';

const engine: RulesSearchEngine = {
	docs: [
		{ id: 'known-rule', section: 'known-section', title: 'Known', headings: [], body: 'b' }
	],
	search: (q: string) =>
		q.includes('challenge')
			? [
					{ doc: { id: 'challenge-sequence', section: 'challenge-phase', title: 'Flow', headings: [], body: 'b' }, score: 2, terms: ['challenge'], bookIndex: 0, phrase: 'challenge flow' },
					{ doc: { id: 'challenge-guard', section: 'challenge-phase', title: 'Guard', headings: [], body: 'b' }, score: 1, terms: ['challenge'], bookIndex: 1, phrase: null }
				]
			: []
};

// Node environment has no KeyboardEvent; duck-type the bits onKeydown reads.
const key = (k: string) => ({ key: k, preventDefault: () => {} }) as KeyboardEvent;

const ruleOf = (id: string, section = 'sec'): RuleEntry => ({ id, section, title: id }) as unknown as RuleEntry;

async function ready(fetchRule: (id: string) => Promise<RuleEntry> = async (id) => ruleOf(id)) {
	const p = createRulesSidePanel('4.0.0', { getEngine: async () => engine, fetchRule });
	p.onFocus();
	await vi.waitFor(() => expect(p.status).toBe('ready'));
	p.onInput('challenge');
	return p;
}

describe('createRulesSidePanel', () => {
	it('loads the engine on first focus: idle -> loading -> ready', async () => {
		const getEngine = vi.fn(async () => engine);
		const p = createRulesSidePanel('4.0.0', { getEngine });
		expect(p.status).toBe('idle');
		p.onFocus();
		expect(p.status).toBe('loading');
		await vi.waitFor(() => expect(p.status).toBe('ready'));
		expect(getEngine).toHaveBeenCalledWith('4.0.0');
	});

	it('reports error on engine failure and a later focus retries', async () => {
		const getEngine = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(engine);
		const p = createRulesSidePanel('4.0.0', { getEngine });
		p.onFocus();
		await vi.waitFor(() => expect(p.status).toBe('error'));
		p.onFocus();
		await vi.waitFor(() => expect(p.status).toBe('ready'));
	});

	it('searches on input and activates the first hit', async () => {
		const p = await ready();
		expect(p.query).toBe('challenge');
		expect(p.hits).toHaveLength(2);
		expect(p.active).toBe(0);
		expect(p.view).toBe('search');
	});

	it('ArrowDown/ArrowUp clamp at the ends', async () => {
		const p = await ready();
		p.onKeydown(key('ArrowUp'));
		expect(p.active).toBe(0);
		p.onKeydown(key('ArrowDown'));
		p.onKeydown(key('ArrowDown'));
		expect(p.active).toBe(1);
		p.onKeydown(key('ArrowUp'));
		expect(p.active).toBe(0);
	});

	it('Enter fetches the active hit and shows the rule with its phrase', async () => {
		const fetchRule = vi.fn(async (id: string) => ruleOf(id));
		const p = await ready(fetchRule);
		p.onKeydown(key('Enter'));
		await vi.waitFor(() => expect(p.ruleStatus).toBe('ready'));
		expect(fetchRule).toHaveBeenCalledWith('challenge-sequence');
		expect(p.view).toBe('rule');
		expect(p.rule?.id).toBe('challenge-sequence');
		expect(p.phrase).toBe('challenge flow');
		expect(p.ruleSection).toBe('challenge-phase');
	});

	it('backToResults and Escape in rule view restore query, hits and active', async () => {
		const p = await ready();
		p.onKeydown(key('ArrowDown'));
		await p.openHit(1);
		expect(p.view).toBe('rule');
		p.backToResults();
		expect(p.view).toBe('search');
		expect(p.query).toBe('challenge');
		expect(p.hits).toHaveLength(2);
		expect(p.active).toBe(1);

		await p.openHit(0);
		p.onKeydown(key('Escape'));
		expect(p.view).toBe('search');
		expect(p.active).toBe(0);
	});

	it('a failed fetch gives error state with ruleId and ruleSection kept', async () => {
		const p = await ready(async () => {
			throw new Error('404');
		});
		await p.openHit(0);
		expect(p.view).toBe('rule');
		expect(p.ruleStatus).toBe('error');
		expect(p.rule).toBeNull();
		expect(p.ruleId).toBe('challenge-sequence');
		expect(p.ruleSection).toBe('challenge-phase');
	});

	it('a slow earlier openHit does not overwrite a later one', async () => {
		let release!: (r: RuleEntry) => void;
		const slow = new Promise<RuleEntry>((res) => (release = res));
		const fetchRule = vi.fn((id: string) => (id === 'challenge-sequence' ? slow : Promise.resolve(ruleOf(id))));
		const p = await ready(fetchRule);
		const first = p.openHit(0);
		await p.openHit(1);
		expect(p.rule?.id).toBe('challenge-guard');
		release(ruleOf('challenge-sequence'));
		await first;
		expect(p.rule?.id).toBe('challenge-guard');
		expect(p.ruleId).toBe('challenge-guard');
		expect(p.ruleStatus).toBe('ready');
	});

	it('a slow load resolving after returning to search does not reopen the rule', async () => {
		let release!: (r: RuleEntry) => void;
		const slow = new Promise<RuleEntry>((res) => (release = res));
		const p = await ready(() => slow);
		const pending = p.openHit(0);
		p.backToResults();
		release(ruleOf('challenge-sequence'));
		await pending;
		expect(p.view).toBe('search');
	});

	it('openRuleById clears phrase and uses the loaded rule section', async () => {
		const p = await ready(async (id) => ruleOf(id, 'from-rule'));
		await p.openHit(0);
		expect(p.phrase).toBe('challenge flow');
		await p.openRuleById('x');
		expect(p.phrase).toBeNull();
		expect(p.ruleId).toBe('x');
		expect(p.ruleSection).toBe('from-rule');
	});

	it('openRuleById failure falls back to a matching engine doc section, else null', async () => {
		const p = await ready(async () => {
			throw new Error('nope');
		});
		await p.openRuleById('known-rule');
		expect(p.ruleStatus).toBe('error');
		expect(p.ruleSection).toBe('known-section');
		await p.openRuleById('unknown');
		expect(p.ruleSection).toBeNull();
	});

	it('onInput while in rule view returns to search', async () => {
		const p = await ready();
		await p.openHit(0);
		p.onInput('challenge x');
		expect(p.view).toBe('search');
		expect(p.query).toBe('challenge x');
	});

	it('Enter during composition does nothing', async () => {
		const fetchRule = vi.fn(async (id: string) => ruleOf(id));
		const p = await ready(fetchRule);
		p.setComposing(true);
		p.onKeydown(key('Enter'));
		expect(fetchRule).not.toHaveBeenCalled();
		expect(p.view).toBe('search');
	});
});
