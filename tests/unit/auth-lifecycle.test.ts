import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Auth, customFetch, skipCSRFCheck, type AuthConfig } from '@auth/core';
import { encode } from '@auth/core/jwt';
import type { Adapter } from '@auth/core/adapters';
import type { Provider } from '@auth/core/providers';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { AppDb } from '$lib/server/db';
import * as schema from '$lib/server/db/schema';
import { createAuthAdapter, discardOAuthTokens } from '$lib/server/auth-adapter';
import {
	AUTH_SESSION_VERSION,
	createAuthCallbacks,
	verifiedProviderEmail
} from '$lib/server/auth-policy';

const ORIGIN = 'http://guild-book.test';
const SECRET = 'auth-lifecycle-integration-test-secret';
const SESSION_COOKIE = 'authjs.session-token';
const baseMigration = readFileSync(
	new URL('../../src/lib/server/db/migrations/0000_dashing_surge.sql', import.meta.url),
	'utf8'
);
const authMigration = readFileSync(
	new URL('../../src/lib/server/db/migrations/0001_auth_account_uniqueness.sql', import.meta.url),
	'utf8'
);
const normalizedEmailMigration = readFileSync(
	new URL('../../src/lib/server/db/migrations/0002_auth_email_normalization.sql', import.meta.url),
	'utf8'
);

type FakeProfile = {
	id: string;
	name: string;
	email: string | null;
	image: null;
};

function fakeOAuthProvider(id: string, getProfile: () => FakeProfile): Provider {
	const tokenFetch = async () =>
		new Response(JSON.stringify({ access_token: `${id}-access`, token_type: 'bearer' }), {
			status: 200,
			headers: {
				'content-type': 'application/json',
				'cache-control': 'no-store',
				pragma: 'no-cache'
			}
		});

	return {
		id,
		name: id,
		type: 'oauth',
		authorization: `https://${id}.example/authorize`,
		token: `https://${id}.example/token`,
		userinfo: {
			url: `https://${id}.example/userinfo`,
			request: async () => getProfile()
		},
		checks: ['state'],
		clientId: `${id}-client`,
		clientSecret: `${id}-secret`,
		profile: async (rawProfile) => {
			const profile = rawProfile as FakeProfile;
			const verificationClaim =
				id === 'google' ? { email_verified: true } : { verified: true };
			return {
				...profile,
				email: verifiedProviderEmail(id, { email: profile.email, ...verificationClaim })
			};
		},
		account: discardOAuthTokens,
		// Auth.js merges provider.options separately and intentionally restores
		// symbol-keyed custom fetch implementations from this object.
		options: { [customFetch]: tokenFetch }
	} as Provider;
}

function responseCookiePairs(response: Response): string[] {
	const headers = response.headers as Headers & { getSetCookie?: () => string[] };
	const values = headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''];
	return values.filter(Boolean).map((value) => value.split(';', 1)[0]);
}

function mergeCookies(...cookieHeaders: Array<string | string[] | undefined>): string {
	const cookies = new Map<string, string>();
	for (const header of cookieHeaders.flatMap((value) => value ?? [])) {
		for (const pair of header.split(/;\s*/)) {
			const separator = pair.indexOf('=');
			if (separator < 1) continue;
			cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
		}
	}
	return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
}

describe('Auth.js OAuth lifecycle', () => {
	let sqlite: Database.Database;
	let db: AppDb;
	let adapter: Adapter;
	let profiles: Record<string, FakeProfile>;
	let config: AuthConfig;

	beforeEach(() => {
		sqlite = new Database(':memory:');
		sqlite.pragma('foreign_keys = ON');
		sqlite.exec(baseMigration);
		sqlite.exec(authMigration);
		sqlite.exec(normalizedEmailMigration);
		db = drizzle(sqlite, { schema });
		adapter = createAuthAdapter(db);
		profiles = {
			google: { id: 'google-new', name: 'Google User', email: 'user@example.com', image: null },
			discord: { id: 'discord-new', name: 'Discord User', email: 'user@example.com', image: null }
		};
		config = {
			providers: [
				fakeOAuthProvider('google', () => profiles.google),
				fakeOAuthProvider('discord', () => profiles.discord)
			],
			adapter,
			secret: SECRET,
			session: { strategy: 'jwt' },
			pages: { signIn: '/login' },
			callbacks: createAuthCallbacks(db),
			skipCSRFCheck,
			trustHost: true,
			logger: { error() {}, warn() {}, debug() {} }
		};
	});

	afterEach(() => sqlite.close());

	async function seedUser(id: string, email: string) {
		return adapter.createUser!({ id, name: id, email, emailVerified: null, image: null });
	}

	async function seedAccount(userId: string, provider: string, providerAccountId: string) {
		await adapter.linkAccount!({ userId, provider, providerAccountId, type: 'oauth' });
	}

	async function sessionCookie(userId: string, includeVersion = true): Promise<string> {
		const token = await encode({
			secret: SECRET,
			salt: SESSION_COOKIE,
			token: {
				sub: userId,
				...(includeVersion ? { sessionVersion: AUTH_SESSION_VERSION } : {})
			}
		});
		return `${SESSION_COOKIE}=${token}`;
	}

	async function runOAuth(provider: 'google' | 'discord', existingCookies?: string) {
		const signIn = await Auth(
			new Request(`${ORIGIN}/auth/signin/${provider}`, {
				method: 'POST',
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
					...(existingCookies ? { cookie: existingCookies } : {})
				},
				body: new URLSearchParams({ callbackUrl: `${ORIGIN}/account` })
			}),
			config
		);
		expect(signIn.status).toBe(302);
		const authorizationUrl = new URL(signIn.headers.get('location')!);
		const state = authorizationUrl.searchParams.get('state');
		expect(state).toBeTruthy();

		const callbackCookies = mergeCookies(existingCookies, responseCookiePairs(signIn));
		const callback = await Auth(
			new Request(
				`${ORIGIN}/auth/callback/${provider}?code=test-code&state=${encodeURIComponent(state!)}`,
				{ headers: { cookie: callbackCookies } }
			),
			config
		);
		return { callback, cookies: mergeCookies(callbackCookies, responseCookiePairs(callback)) };
	}

	it('rejects signed-out same-email OAuth instead of auto-linking', async () => {
		await seedUser('existing-user', 'user@example.com');
		await seedAccount('existing-user', 'google', 'google-existing');

		const { callback } = await runOAuth('discord');

		expect(callback.status).toBe(302);
		expect(callback.headers.get('location')).toBe(
			`${ORIGIN}/login?error=OAuthAccountNotLinked`
		);
		await expect(
			adapter.getUserByAccount!({ provider: 'discord', providerAccountId: 'discord-new' })
		).resolves.toBeNull();
	});

	it('rejects a signed-out provider when verified email casing differs', async () => {
		await seedUser('existing-user', 'user@example.com');
		await seedAccount('existing-user', 'google', 'google-existing');
		profiles.discord.email = 'User@Example.com';

		const { callback } = await runOAuth('discord');

		expect(callback.status).toBe(302);
		expect(callback.headers.get('location')).toBe(
			`${ORIGIN}/login?error=OAuthAccountNotLinked`
		);
		await expect(
			adapter.getUserByAccount!({ provider: 'discord', providerAccountId: 'discord-new' })
		).resolves.toBeNull();
	});

	it('links a new second provider only while the local user is signed in', async () => {
		await seedUser('current-user', 'user@example.com');
		await seedAccount('current-user', 'google', 'google-existing');

		const { callback } = await runOAuth('discord', await sessionCookie('current-user'));

		expect(callback.status).toBe(302);
		expect(callback.headers.get('location')).toBe(`${ORIGIN}/account`);
		await expect(
			adapter.getUserByAccount!({ provider: 'discord', providerAccountId: 'discord-new' })
		).resolves.toMatchObject({ id: 'current-user' });
	});

	it('preserves the current session when the provider belongs to another user', async () => {
		await seedUser('current-user', 'current@example.com');
		await seedAccount('current-user', 'google', 'google-existing');
		await seedUser('other-user', 'other@example.com');
		await seedAccount('other-user', 'discord', 'discord-owned');
		profiles.discord = {
			id: 'discord-owned',
			name: 'Other Discord User',
			email: 'other@example.com',
			image: null
		};
		const currentCookie = await sessionCookie('current-user');

		const { callback } = await runOAuth('discord', currentCookie);

		expect(callback.status).toBe(302);
		expect(callback.headers.get('location')).toBe(
			`${ORIGIN}/login?error=OAuthAccountNotLinked`
		);
		await expect(
			adapter.getUserByAccount!({ provider: 'discord', providerAccountId: 'discord-owned' })
		).resolves.toMatchObject({ id: 'other-user' });

		const session = await Auth(
			new Request(`${ORIGIN}/auth/session`, { headers: { cookie: currentCookie } }),
			config
		);
		await expect(session.json()).resolves.toMatchObject({ user: { id: 'current-user' } });
	});

	it('clears a legacy JWT that has no current session version', async () => {
		await seedUser('legacy-user', 'legacy@example.com');
		const legacyCookie = await sessionCookie('legacy-user', false);

		const session = await Auth(
			new Request(`${ORIGIN}/auth/session`, { headers: { cookie: legacyCookie } }),
			config
		);

		expect(await session.json()).toBeNull();
		expect(responseCookiePairs(session).some((cookie) => cookie === `${SESSION_COOKIE}=`)).toBe(
			true
		);
	});

	it('clears a current JWT after its durable user is deleted', async () => {
		await seedUser('deleted-user', 'deleted@example.com');
		const deletedUserCookie = await sessionCookie('deleted-user');
		await adapter.deleteUser!('deleted-user');

		const session = await Auth(
			new Request(`${ORIGIN}/auth/session`, { headers: { cookie: deletedUserCookie } }),
			config
		);

		expect(await session.json()).toBeNull();
		expect(responseCookiePairs(session).some((cookie) => cookie === `${SESSION_COOKIE}=`)).toBe(
			true
		);
	});
});
