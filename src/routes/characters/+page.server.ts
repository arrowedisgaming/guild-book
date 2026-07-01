import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { characters } from '$lib/server/db/schema';
import { and, desc, eq } from 'drizzle-orm';

/** "My Adventurers" — the signed-in user's saved characters. */
export const load: PageServerLoad = async (event) => {
	const session = await event.locals.auth();
	const userId = session?.user?.id;
	if (!userId) throw redirect(302, '/login?callbackUrl=/characters');

	const db = await getDb(event);
	const rows = await db
		.select({
			id: characters.id,
			name: characters.name,
			kith: characters.kith,
			path: characters.path,
			isDraft: characters.isDraft,
			isPublic: characters.isPublic,
			updatedAt: characters.updatedAt
		})
		.from(characters)
		.where(and(eq(characters.userId, userId), eq(characters.isArchived, false)))
		.orderBy(desc(characters.updatedAt));

	return { characters: rows };
};
