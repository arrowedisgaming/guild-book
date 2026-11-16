import { error, json } from '@sveltejs/kit';
import { getRules } from '$lib/server/content/loader';
import type { RequestHandler } from './$types';

/**
 * Public, read-only: one rule's full entry (markdown included). The client
 * search index only carries plain text, so the rules side panel fetches here.
 * An exact `id` wins over an alias of a different rule.
 */
export const GET: RequestHandler = ({ params }) => {
	const rules = getRules();
	const rule =
		rules.find((r) => r.id === params.id) ?? rules.find((r) => r.aliases?.includes(params.id));
	if (!rule) throw error(404, 'Rule not found');
	return json({ rule }, { headers: { 'Cache-Control': 'public, max-age=3600' } });
};
