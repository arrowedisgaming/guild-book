import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDenizenThemes, getDenizenThreats, getBestiary } from '$lib/server/content/loader';

export const load: PageServerLoad = async (event) => {
	const denizen = getBestiary().find((d) => d.id === event.params.id);
	if (!denizen) throw error(404, `No denizen “${event.params.id}”.`);
	const theme = getDenizenThemes().find((t) => t.id === denizen.theme);
	const threat = getDenizenThreats().find((t) => t.id === denizen.threat);
	const themeName = theme?.name ?? denizen.theme;
	// threat is optional on the type (builder-made people omit it); bestiary
	// entries always have one, but resolve to '' so the props stay strings.
	const threatName = threat?.name ?? denizen.threat ?? '';
	// "Customize in the builder" only offers templates the builder supports.
	// A person-mode theme paired with a threat is a contradiction the builder
	// can't represent (people have no threat template) — no such entry exists
	// today, but content is data and may change under us.
	const usable = (mode?: string) => (mode ?? 'standard') !== 'unsupported';
	const builderReady =
		usable(theme?.builderMode) &&
		usable(threat?.builderMode) &&
		!(theme?.builderMode === 'person' && denizen.threat);
	return {
		denizen,
		themeName,
		threatName,
		builderReady,
		// The pack decides what a person is; the client never infers it.
		personTheme: theme?.builderMode === 'person'
	};
};
