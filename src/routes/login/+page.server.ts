import type { PageServerLoad } from './$types';

/**
 * Expose whether the dev Credentials provider is actually wired up. The login
 * page gates its dev sign-in form on this flag; without it the form would
 * render in dev mode even when AUTH_DEV_LOGIN is off, producing a click that
 * calls signIn('credentials') against an unregistered provider.
 */
export const load: PageServerLoad = (event) => {
	const platform = event.platform as { env?: Record<string, string | undefined> } | undefined;
	const platformValue = platform?.env?.AUTH_DEV_LOGIN;
	const value =
		typeof platformValue === 'string' && platformValue.length > 0
			? platformValue
			: typeof process !== 'undefined'
				? process.env.AUTH_DEV_LOGIN
				: undefined;
	const flagOn =
		typeof value === 'string' && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
	const nodeEnv =
		(platform?.env?.NODE_ENV as string | undefined) ??
		(typeof process !== 'undefined' ? process.env.NODE_ENV : undefined) ??
		'production';

	return {
		devLoginEnabled: flagOn && nodeEnv === 'development'
	};
};
