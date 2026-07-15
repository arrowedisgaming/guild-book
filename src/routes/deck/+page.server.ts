import type { PageServerLoad } from './$types';
import { getContentPack } from '$lib/server/content/loader';

// The tarot config drives both deck modes; no auth required.
// `?seed=` pins the shuffle so a run is reproducible — the deck tool is the
// engine's reference client, and E2E cannot assert an outcome against a random
// deck. It is a dev/testing affordance, not a game rule.
export const load: PageServerLoad = async ({ url }) => {
	return {
		tarot: getContentPack().tarot,
		seed: url.searchParams.get('seed') ?? null
	};
};
