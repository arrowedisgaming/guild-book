/** Handler tests for GET /api/rules/:id (public, read-only, full rule markdown). */

import { describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { getRules } from '$lib/server/content/loader';

const { GET } = await import('../../src/routes/api/rules/[id]/+server');

function call(id: string): Promise<Response> | Response {
	return GET({ params: { id } } as unknown as RequestEvent<{ id: string }, '/api/rules/[id]'>);
}

describe('GET /api/rules/:id', () => {
	it('returns the rule for a known id with a cache header', async () => {
		const rule = getRules()[0];
		const res = await call(rule.id);
		expect(res.status).toBe(200);
		expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
		expect(await res.json()).toEqual({ rule });
	});

	it('resolves an alias to its owning rule', async () => {
		const owner = getRules().find((r) => r.aliases?.length)!;
		expect(owner).toBeDefined();
		const res = await call(owner.aliases![0]);
		expect(res.status).toBe(200);
		expect(((await res.json()) as { rule: { id: string } }).rule.id).toBe(owner.id);
	});

	it('rejects an unknown id with 404', async () => {
		await expect(Promise.resolve().then(() => call('no-such-rule'))).rejects.toMatchObject({
			status: 404
		});
	});
});
