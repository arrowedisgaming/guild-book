import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { denizens } from '$lib/server/db/schema';
import { getUserId } from '$lib/server/auth';
import { getDenizenThemes, getDenizenThreats } from '$lib/server/content/loader';
import { privateHeaders } from '$lib/server/http';
import { and, desc, eq } from 'drizzle-orm';

/** "My Denizens" — the signed-in user's saved denizens. */
export const load: PageServerLoad = async (event) => {
	event.setHeaders(privateHeaders());
	const userId = await getUserId(event);
	if (!userId) throw redirect(302, '/login?callbackUrl=/denizens/mine');

	const db = await getDb(event);
	const rows = await db
		.select({
			id: denizens.id,
			name: denizens.name,
			theme: denizens.theme,
			threat: denizens.threat,
			updatedAt: denizens.updatedAt
		})
		.from(denizens)
		.where(and(eq(denizens.userId, userId), eq(denizens.isArchived, false)))
		.orderBy(desc(denizens.updatedAt));

	const themeNames = new Map(getDenizenThemes().map((t) => [t.id, t.name]));
	const threatNames = new Map(getDenizenThreats().map((t) => [t.id, t.name]));

	// A content-pack update can retire an id out from under a saved row; say
	// so instead of leaking the raw id or silently showing nothing.
	const retired = (id: string) => (id ? `${id} (no longer in the pack)` : '');

	return {
		denizens: rows.map((row) => ({
			...row,
			themeName: themeNames.get(row.theme) ?? retired(row.theme),
			threatName: threatNames.get(row.threat) ?? retired(row.threat)
		}))
	};
};
