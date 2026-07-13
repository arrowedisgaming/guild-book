import type { PageServerLoad } from './$types';
import { getDenizenThemes, getDenizenThreats, getBestiary } from '$lib/server/content/loader';

// The denizen reference is content-pack driven and public.
export const load: PageServerLoad = async () => {
	return {
		themes: getDenizenThemes(),
		threats: getDenizenThreats(),
		bestiary: getBestiary()
	};
};
