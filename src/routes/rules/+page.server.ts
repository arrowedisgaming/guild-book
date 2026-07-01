import type { PageServerLoad } from './$types';
import { getRules } from '$lib/server/content/loader';

// The rules reference is content-pack driven and public.
export const load: PageServerLoad = async () => {
	const rules = getRules();
	const sections = [...new Set(rules.map((r) => r.section))];
	return { rules, sections };
};
