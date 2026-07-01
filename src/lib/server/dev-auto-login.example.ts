/**
 * Dev-only auto-login pass-through (TEMPLATE).
 *
 * This is the committed template. To enable auto-login on your local machine:
 *
 *   1. cp src/lib/server/dev-auto-login.example.ts src/lib/server/dev-auto-login.ts
 *   2. Add AUTH_DEV_AUTOLOGIN=true to your .env (NODE_ENV must also be development)
 *   3. Restart `npm run dev`
 *
 * The copy at `dev-auto-login.ts` is gitignored — it never reaches GitHub.
 * Production deployments do not have this file, and `hooks.server.ts` falls back
 * to a no-op when the dynamic import fails.
 *
 * Defense-in-depth: even if this file were somehow shipped to production, the
 * NODE_ENV !== 'development' check below early-exits before doing anything.
 */
import type { Handle, RequestEvent } from '@sveltejs/kit';
import { encode } from '@auth/core/jwt';
import { DEV_AUTH_SECRET, findOrCreateUserByEmail } from '$lib/server/auth';

const SESSION_COOKIE_NAME = 'authjs.session-token';
const DEV_USER_EMAIL = 'dev@local';
const DEV_USER_NAME = 'Dev User';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30 days, matches Auth.js default
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

type EnvPlatform = { env?: Record<string, string | unknown | undefined> };

function getEnv(event: RequestEvent, key: string): string | undefined {
	const platform = event.platform as EnvPlatform | undefined;
	const platformValue = platform?.env?.[key];
	if (typeof platformValue === 'string' && platformValue.length > 0) return platformValue;
	if (typeof process !== 'undefined') return process.env[key];
	return undefined;
}

function isFlagOn(value: string | undefined): boolean {
	if (!value) return false;
	const v = value.trim().toLowerCase();
	return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export const devAutoLoginHandle: Handle = async ({ event, resolve }) => {
	const nodeEnv = getEnv(event, 'NODE_ENV') ?? 'production';
	if (nodeEnv !== 'development') return resolve(event);
	if (!isFlagOn(getEnv(event, 'AUTH_DEV_AUTOLOGIN'))) return resolve(event);

	// Refuse non-loopback hosts. Without this, `npm run dev -- --host` would
	// auto-login any peer on the LAN as the dev user.
	if (!LOOPBACK_HOSTS.has(event.url.hostname)) return resolve(event);

	if (event.cookies.get(SESSION_COOKIE_NAME)) return resolve(event);

	const db = event.locals.db;
	if (!db) return resolve(event);

	const user = await findOrCreateUserByEmail(db, {
		email: DEV_USER_EMAIL,
		name: DEV_USER_NAME
	});
	if (!user) return resolve(event);

	// Mirror auth.ts secret resolution — Auth.js verifies with whatever it finds
	// at AUTH_SECRET first, falling back to DEV_AUTH_SECRET only when unset.
	const signingSecret = getEnv(event, 'AUTH_SECRET') ?? DEV_AUTH_SECRET;

	const jwt = await encode({
		salt: SESSION_COOKIE_NAME,
		secret: signingSecret,
		maxAge: SESSION_MAX_AGE,
		token: {
			id: user.id,
			sub: user.id,
			email: user.email,
			name: user.name ?? DEV_USER_NAME
		}
	});

	// Persist for next time...
	event.cookies.set(SESSION_COOKIE_NAME, jwt, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: false,
		maxAge: SESSION_MAX_AGE
	});

	// ...AND inject into the request the downstream authHandle reads from, so
	// the very first request already carries a valid session.
	const newHeaders = new Headers(event.request.headers);
	const existingCookie = newHeaders.get('cookie');
	const injected = `${SESSION_COOKIE_NAME}=${jwt}`;
	newHeaders.set('cookie', existingCookie ? `${existingCookie}; ${injected}` : injected);
	const rebuilt = new Request(event.request.url, {
		method: event.request.method,
		headers: newHeaders,
		body: ['GET', 'HEAD'].includes(event.request.method) ? undefined : event.request.body,
		// @ts-expect-error duplex required by undici when body is a stream
		duplex: 'half'
	});
	(event as { request: Request }).request = rebuilt;

	return resolve(event);
};
