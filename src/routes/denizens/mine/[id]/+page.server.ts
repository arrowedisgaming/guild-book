import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { denizens } from '$lib/server/db/schema';
import { getUserId } from '$lib/server/auth';
import { getDenizenThemes, getDenizenThreats } from '$lib/server/content/loader';
import { sanitizeDraft } from '$lib/engine/denizen-builder';
import { privateHeaders } from '$lib/server/http';
import { and, eq } from 'drizzle-orm';

/**
 * A saved denizen, own namespace under /denizens/mine so user ids can never
 * shadow bestiary content at /denizens/[id]. The stored draft is sanitized
 * on read (pack drift) and re-materialized by the page — draft is truth.
 */
export const load: PageServerLoad = async (event) => {
	event.setHeaders(privateHeaders());
	const userId = await getUserId(event);
	if (!userId) {
		throw redirect(
			302,
			`/login?callbackUrl=${encodeURIComponent(`/denizens/mine/${event.params.id}`)}`
		);
	}

	const db = await getDb(event);
	const row = await db
		.select()
		.from(denizens)
		.where(and(eq(denizens.id, event.params.id), eq(denizens.userId, userId)))
		.get();

	if (!row || row.isArchived) throw error(404, 'Your denizen is in another dungeon.');

	let storedDraft: unknown;
	try {
		storedDraft = JSON.parse(row.data);
	} catch {
		storedDraft = null;
	}
	const draft = sanitizeDraft(storedDraft);

	// Same retired-id honesty as the list page: a renamed pack id shows as
	// retired rather than silently dropping the line from the stat block.
	const retired = (id: string | null) => (id ? `${id} (no longer in the pack)` : '');

	return {
		id: row.id,
		version: row.version,
		draft,
		themeName: getDenizenThemes().find((t) => t.id === draft.themeId)?.name ?? retired(draft.themeId),
		threatName:
			getDenizenThreats().find((t) => t.id === draft.threatId)?.name ?? retired(draft.threatId)
	};
};
