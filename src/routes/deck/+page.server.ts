import type { PageServerLoad } from './$types';
import { getContentPack } from '$lib/server/content/loader';

// The tarot config drives both deck modes; no auth required.
export const load: PageServerLoad = async () => {
	return { tarot: getContentPack().tarot };
};
