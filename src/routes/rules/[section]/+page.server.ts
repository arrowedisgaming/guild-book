import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getRules } from '$lib/server/content/loader';

export const load: PageServerLoad = async (event) => {
	const section = event.params.section;
	const rules = getRules().filter((r) => r.section === section);
	if (rules.length === 0) throw error(404, `No rules section “${section}”.`);
	return { section, rules };
};
