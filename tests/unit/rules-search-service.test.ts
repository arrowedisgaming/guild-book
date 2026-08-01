import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	cleanQuery,
	foldText,
	getRulesSearch,
	hitHref,
	resetRulesSearchForTests,
	tokenize
} from '$lib/search/rules-search';

const DOCS = [
	{ id: 'tests-of-fate', section: 'basics', title: 'Tests of Fate', headings: ['Attributes'], body: 'Draw a card to test fate. Death’s Door is elsewhere.' },
	{ id: 'challenge-sequence', section: 'challenge-phase', title: 'The Flow of the Challenge Phase', headings: [], body: 'The Challenge Phase is played in rounds and turns.' },
	{ id: 'challenge-guard', section: 'challenge-phase', title: 'Guard', headings: [], body: 'Replace your Initiative to guard during a challenge.' },
	{ id: 'crawl-hazards', section: 'crawl-phase', title: 'Abandon All Hope', headings: ['Dealing with traps'], body: 'Hazards ahead. Dealing with traps is careful work.' },
	{ id: 'crawl-scattered', section: 'crawl-phase', title: 'Scattered Terms', headings: [], body: 'Dealing damage happens. Go with the guild. Avoid traps always.' }
] as const;

function okFetch(payload: unknown = DOCS) {
	return vi.fn(async (..._args: Parameters<typeof fetch>) => new Response(JSON.stringify(payload), { status: 200 }));
}

describe('rules search service', () => {
	beforeEach(() => resetRulesSearchForTests());

	it('folds case and both apostrophe styles', () => {
		expect(foldText('Death’s')).toBe(foldText("death's"));
		expect(tokenize('Death’s Door!')).toEqual(['deaths', 'door']);
	});

	it('fetches once for concurrent callers, with the pack version in the URL', async () => {
		const f = okFetch();
		const [a, b] = await Promise.all([getRulesSearch('4.0.0', f), getRulesSearch('4.0.0', f)]);
		expect(a).toBe(b);
		expect(f).toHaveBeenCalledTimes(1);
		expect(String(f.mock.calls[0][0])).toBe('/content-packs/hmtw/rules-search.json?v=4.0.0');
	});

	it('clears the memo on failure so the next call retries', async () => {
		const bad = vi.fn(async () => new Response('nope', { status: 500 }));
		await expect(getRulesSearch('4.0.0', bad)).rejects.toThrow(/500/);
		const good = okFetch();
		const engine = await getRulesSearch('4.0.0', good);
		expect(engine.docs).toHaveLength(5);
	});

	it('ranks title matches above body matches and reports matched terms', async () => {
		const engine = await getRulesSearch('4.0.0', okFetch());
		const hits = engine.search('challenge');
		expect(hits[0].doc.id).toBe('challenge-sequence'); // title hit beats body hit
		expect(hits.map((h) => h.doc.id)).toContain('challenge-guard');
		expect(hits[0].terms).toContain('challenge');
	});

	it('finds fuzzy and prefix matches', async () => {
		const engine = await getRulesSearch('4.0.0', okFetch());
		expect(engine.search('challnge').map((h) => h.doc.id)).toContain('challenge-sequence'); // fuzzy
		expect(engine.search('chall').map((h) => h.doc.id)).toContain('challenge-sequence'); // prefix
	});

	it('requires every term to match (AND) and matches through apostrophes', async () => {
		const engine = await getRulesSearch('4.0.0', okFetch());
		expect(engine.search('challenge nonexistentword')).toEqual([]);
		expect(engine.search("death's door").map((h) => h.doc.id)).toEqual(['tests-of-fate']);
	});

	it('gives an exact-title query the top slot and breaks score ties by book order', async () => {
		const engine = await getRulesSearch('4.0.0', okFetch());
		expect(engine.search('guard')[0].doc.id).toBe('challenge-guard');
		const tie = engine.search('challenge phase');
		const idx = tie.map((h) => h.bookIndex);
		expect([...idx].every((v, i) => i === 0 || tie[i - 1].score > tie[i].score || idx[i - 1] < v)).toBe(true);
	});

	it('returns no results for queries shorter than 2 letters', async () => {
		const engine = await getRulesSearch('4.0.0', okFetch());
		expect(engine.search('a')).toEqual([]);
		expect(engine.search('  ')).toEqual([]);
	});
});

describe('phrase-aware search', () => {
	beforeEach(() => resetRulesSearchForTests());

	it('strips straight and curly double quotes from queries', () => {
		expect(cleanQuery('"dealing with traps"')).toBe('dealing with traps');
		expect(cleanQuery('“dealing  with traps”')).toBe('dealing with traps');
	});

	it('ranks a verbatim phrase occurrence above scattered-terms matches', async () => {
		const engine = await getRulesSearch('4.0.0', okFetch());
		const hits = engine.search('dealing with traps');
		expect(hits.map((h) => h.doc.id)).toEqual(['crawl-hazards', 'crawl-scattered']);
		expect(hits[0].phrase).toBe('dealing with traps');
		expect(hits[1].phrase).toBeNull();
	});

	it('treats quoted queries identically to unquoted ones', async () => {
		const engine = await getRulesSearch('4.0.0', okFetch());
		const quoted = engine.search('“dealing with traps”');
		const plain = engine.search('dealing with traps');
		expect(quoted.map((h) => h.doc.id)).toEqual(plain.map((h) => h.doc.id));
		expect(quoted[0].phrase).toBe('dealing with traps');
	});

	it('single-word queries never claim a phrase match', async () => {
		const engine = await getRulesSearch('4.0.0', okFetch());
		for (const hit of engine.search('traps')) expect(hit.phrase).toBeNull();
	});

	it('hitHref carries the phrase as ?hl= before the anchor', () => {
		const base = {
			doc: { ...DOCS[3], headings: [...DOCS[3].headings] },
			score: 1,
			terms: [] as string[],
			bookIndex: 3
		};
		expect(hitHref({ ...base, phrase: 'dealing with traps' })).toBe(
			'/rules/crawl-phase?hl=dealing%20with%20traps#crawl-hazards'
		);
		expect(hitHref({ ...base, phrase: null })).toBe('/rules/crawl-phase#crawl-hazards');
	});

	it('phrase matches outrank scattered matches even against extreme term frequency', async () => {
		const spam = 'dealing damage with allies near traps. '.repeat(60);
		const docs = [
			{ id: 'spam', section: 'crawl-phase', title: 'Spam', headings: [], body: spam },
			{ id: 'real', section: 'crawl-phase', title: 'Real', headings: [], body: 'Dealing with traps is careful work.' }
		];
		const engine = await getRulesSearch('4.0.0', okFetch(docs));
		const hits = engine.search('dealing with traps');
		expect(hits[0].doc.id).toBe('real');
		expect(hits[0].phrase).toBe('dealing with traps');
	});

	it('exact-title bonus still applies when the query is quoted', async () => {
		const engine = await getRulesSearch('4.0.0', okFetch());
		expect(engine.search('"guard"')[0].doc.id).toBe('challenge-guard');
	});
});
