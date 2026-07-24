import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDenizenThemes, getDenizenThreats, getBestiary } from '$lib/server/content/loader';

export const load: PageServerLoad = async (event) => {
	const denizen = getBestiary().find((d) => d.id === event.params.id);
	if (!denizen) throw error(404, `No denizen “${event.params.id}”.`);
	const themeName = getDenizenThemes().find((t) => t.id === denizen.theme)?.name ?? denizen.theme;
	// threat is optional on the type (builder-made people omit it); bestiary
	// entries always have one, but resolve to '' so the props stay strings.
	const threatName =
		getDenizenThreats().find((t) => t.id === denizen.threat)?.name ?? denizen.threat ?? '';
	return { denizen, themeName, threatName };
};
