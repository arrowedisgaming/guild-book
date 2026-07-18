import type { PageServerLoad } from './$types';
import {
	getDenizenThemes,
	getDenizenThreats,
	getKiths,
	getPaths,
	getTalents
} from '$lib/server/content/loader';

// The denizen builder is content-pack driven and public. Kiths, paths, and
// talents feed the person path's pickers — public data, no session involved.
export const load: PageServerLoad = async () => {
	return {
		themes: getDenizenThemes(),
		threats: getDenizenThreats(),
		kiths: getKiths(),
		paths: getPaths(),
		talents: getTalents()
	};
};
