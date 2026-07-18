import type { PageServerLoad } from './$types';
import { getDenizenThemes, getDenizenThreats, getKiths } from '$lib/server/content/loader';

// The denizen builder is content-pack driven and public. Kiths feed the
// person path's flavour-only kith picker — public data, no session involved.
export const load: PageServerLoad = async () => {
	return { themes: getDenizenThemes(), threats: getDenizenThreats(), kiths: getKiths() };
};
