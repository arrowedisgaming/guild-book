import type { LayoutServerLoad } from './$types';

// Surfaces the signed-in session (if any) and the app version to every page.
export const load: LayoutServerLoad = async (event) => {
	const session = await event.locals.auth();
	return {
		appVersion: __APP_VERSION__,
		user: session?.user ? { name: session.user.name ?? null, email: session.user.email ?? null } : null
	};
};
