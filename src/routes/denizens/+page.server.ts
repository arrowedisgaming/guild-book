import type { PageServerLoad } from './$types';
import { getDenizenThemes, getDenizenThreats, getBestiary } from '$lib/server/content/loader';
import { getDb } from '$lib/server/db';
import { denizens } from '$lib/server/db/schema';
import { getUserId } from '$lib/server/auth';
import { privateHeaders } from '$lib/server/http';
import { and, desc, eq } from 'drizzle-orm';

/** The "Your denizens" strip shows the freshest few; the full list lives at /denizens/mine. */
const MINE_STRIP_LIMIT = 20;

// The denizen reference is content-pack driven and public. Signed-in users
// additionally see their own saved denizens, visually separate from book
// content; anonymous visitors get the reference exactly as before. Because
// the response only varies for signed-in visitors, the cache posture varies
// too: personal responses are never stored, anonymous ones key on the cookie.
export const load: PageServerLoad = async (event) => {
	const userId = await getUserId(event);
	event.setHeaders(userId ? privateHeaders() : { Vary: 'Cookie' });
	const mine = userId
		? await (await getDb(event))
				.select({ id: denizens.id, name: denizens.name, theme: denizens.theme, threat: denizens.threat })
				.from(denizens)
				.where(and(eq(denizens.userId, userId), eq(denizens.isArchived, false)))
				.orderBy(desc(denizens.updatedAt))
				.limit(MINE_STRIP_LIMIT)
		: [];

	return {
		themes: getDenizenThemes(),
		threats: getDenizenThreats(),
		bestiary: getBestiary(),
		mine
	};
};
