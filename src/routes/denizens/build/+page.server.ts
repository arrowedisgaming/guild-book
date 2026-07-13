import type { PageServerLoad } from './$types';
import { getDenizenThemes, getDenizenThreats } from '$lib/server/content/loader';

// The denizen builder is content-pack driven and public.
export const load: PageServerLoad = async () => {
	return { themes: getDenizenThemes(), threats: getDenizenThreats() };
};
