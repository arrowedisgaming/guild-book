import { error, type RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getEnv, getUserId } from '$lib/server/auth';
import { getDb } from '$lib/server/db';
import { users } from '$lib/server/db/schema';

export interface AdminConfig {
	adminEmails: ReadonlySet<string>;
}

/**
 * Server-only admin rollout configuration; never return this in page data.
 * An unset or empty `ADMIN_EMAILS` yields an empty set, so the default posture
 * is that nobody is an admin.
 */
export function getAdminConfig(event: RequestEvent): AdminConfig {
	const adminEmails = new Set(
		(getEnv(event, 'ADMIN_EMAILS') ?? '')
			.split(',')
			.map((value) => value.trim().toLowerCase())
			.filter(Boolean)
	);

	return { adminEmails };
}

export function isAdminEmail(config: AdminConfig, email: string | null | undefined): boolean {
	if (!email) return false;
	return config.adminEmails.has(email.trim().toLowerCase());
}

/**
 * Gate an admin-only route. Throws 404 — never 401 or 403 — for anonymous
 * users and signed-in non-admins alike, so the route's existence is not
 * disclosed to a curious beta tester.
 *
 * The email is resolved from the `users` row rather than `session.user.email`:
 * only the stored column has been through `verifiedProviderEmail`, so only it
 * is safe to compare against the allowlist.
 */
export async function requireAdmin(
	event: RequestEvent
): Promise<{ userId: string; email: string }> {
	const notFound = () => error(404, 'Not found');

	const userId = await getUserId(event);
	if (!userId) throw notFound();

	const db = await getDb(event);
	const row = await db
		.select({ email: users.email })
		.from(users)
		.where(eq(users.id, userId))
		.get();

	if (!isAdminEmail(getAdminConfig(event), row?.email)) throw notFound();

	return { userId, email: row!.email! };
}
