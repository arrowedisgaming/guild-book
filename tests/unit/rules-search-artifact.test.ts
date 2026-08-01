import { readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import rules from '../../static/content-packs/hmtw/rules.json';
import pack from '../../static/content-packs/hmtw/index.json';
import { ruleSearchDocSchema } from '$lib/schemas/content-pack.schema';

const PATH = 'static/content-packs/hmtw/rules-search.json';

describe('rules-search.json artifact', () => {
	const docs = JSON.parse(readFileSync(PATH, 'utf8')) as unknown[];

	it('is declared in the pack files (and therefore inside the content digest)', () => {
		expect((pack.files as Record<string, string>).rulesSearch).toBe('rules-search.json');
	});

	it('validates every document against the schema', () => {
		expect(() => z.array(ruleSearchDocSchema).parse(docs)).not.toThrow();
	});

	it('is bijective with rules.json, in the same (book) order', () => {
		const parsed = z.array(ruleSearchDocSchema).parse(docs);
		expect(parsed.map((d) => d.id)).toEqual(rules.map((r) => r.id));
	});

	it('contains plain text — no markdown syntax survives', () => {
		const parsed = z.array(ruleSearchDocSchema).parse(docs);
		for (const d of parsed) {
			expect(d.body, d.id).not.toMatch(/^#{1,6}\s|\*\*|\[\[|^\s*-\s|\|/m);
		}
	});

	it('stays inside the size budgets (700KB raw / 200KB gzip)', () => {
		const raw = statSync(PATH).size;
		const zipped = gzipSync(readFileSync(PATH)).length;
		console.log(`rules-search.json: ${raw} bytes raw, ${zipped} bytes gzip`);
		expect(raw).toBeLessThanOrEqual(700 * 1024);
		expect(zipped).toBeLessThanOrEqual(200 * 1024);
	});
});
