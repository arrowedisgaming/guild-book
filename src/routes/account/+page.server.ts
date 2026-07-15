import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { eq } from 'drizzle-orm';
import { getUserId } from '$lib/server/auth';
import { getDb } from '$lib/server/db';
import { accounts, users } from '$lib/server/db/schema';

const LOGIN_PROVIDERS = ['google', 'discord'] as const;

/** Signed-in account overview and the only UI that initiates provider linking. */
export const load: PageServerLoad = async (event) => {
	const userId = await getUserId(event);
	if (!userId) throw redirect(302, '/login?callbackUrl=/account');

	const db = await getDb(event);
	const [user, accountRows] = await Promise.all([
		db
			.select({ name: users.name, email: users.email })
			.from(users)
			.where(eq(users.id, userId))
			.get(),
		db.select({ provider: accounts.provider }).from(accounts).where(eq(accounts.userId, userId))
	]);

	if (!user) throw redirect(302, '/login?error=SessionRequired');

	const linked = new Set(accountRows.map((account) => account.provider));
	return {
		user,
		providers: LOGIN_PROVIDERS.map((id) => ({ id, linked: linked.has(id) }))
	};
};
