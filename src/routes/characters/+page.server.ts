import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { characters } from '$lib/server/db/schema';
import { getUserId } from '$lib/server/auth';
import { and, desc, eq } from 'drizzle-orm';

/** "My Adventurers" — the signed-in user's saved characters. */
export const load: PageServerLoad = async (event) => {
	const userId = await getUserId(event);
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
