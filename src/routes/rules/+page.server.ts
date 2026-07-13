import type { PageServerLoad } from './$types';
import { getRules } from '$lib/server/content/loader';
import { sectionOrder } from '$lib/content/sections';

/**
 * The rules reference is content-pack driven and public. The index ships only a
 * lightweight table of contents (id/section/title/tags) — never the full bodies
 * — so the SSR/hydration payload stays small as the reference grows toward
 * full-book coverage. The client lazy-fetches the static `rules.json` for
 * full-text search, and `/rules/[section]` renders the full bodies on demand.
 */
export const load: PageServerLoad = async () => {
	const toc = getRules()
		.map((r) => ({ id: r.id, section: r.section, title: r.title, tags: r.tags }))
		.sort((a, b) => sectionOrder(a.section) - sectionOrder(b.section));
	const sections = [...new Set(toc.map((r) => r.section))];
	return { toc, sections };
};
