import { error, type RequestEvent } from '@sveltejs/kit';
import { SvelteKitAuth } from '@auth/sveltekit';
import Google from '@auth/sveltekit/providers/google';
import Discord from '@auth/sveltekit/providers/discord';
import Credentials from '@auth/sveltekit/providers/credentials';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { getDb } from './db';
import { users } from './db/schema';
import { createAuthAdapter, discardOAuthTokens } from './auth-adapter';
import { createAuthCallbacks, discordUserProfile, googleUserProfile } from './auth-policy';

type EnvPlatform = {
	env?: Record<string, string | D1Database | undefined>;
};

export const DEV_AUTH_SECRET = 'guild-book-local-development-secret';

function getEnv(event: RequestEvent, key: string): string | undefined {
	const platform = event.platform as EnvPlatform | undefined;
	const platformValue = platform?.env?.[key];
	if (typeof platformValue === 'string' && platformValue.length > 0) return platformValue;

	if (typeof process !== 'undefined') {
		return process.env[key];
	}

	return undefined;
}

export const { handle, signIn, signOut } = SvelteKitAuth(async (event) => {
	const googleId = getEnv(event, 'AUTH_GOOGLE_ID');
	const googleSecret = getEnv(event, 'AUTH_GOOGLE_SECRET');
	const discordId = getEnv(event, 'AUTH_DISCORD_ID');
	const discordSecret = getEnv(event, 'AUTH_DISCORD_SECRET');
	const nodeEnv = getEnv(event, 'NODE_ENV') ?? 'production';
	const isDev = nodeEnv === 'development';
	const authSecret = getEnv(event, 'AUTH_SECRET') ?? (isDev ? DEV_AUTH_SECRET : undefined);

	if (!authSecret) {
		throw new Error(
			'[auth] AUTH_SECRET is required in production. Set it in your platform env, or run with NODE_ENV=development to use the dev fallback.'
		);
	}

	const db = await getDb(event);

	const providers = [];

	if (googleId && googleSecret) {
		providers.push(
			Google({
				clientId: googleId,
				clientSecret: googleSecret,
				profile: googleUserProfile,
				account: discardOAuthTokens
			})
		);
	}

	if (discordId && discordSecret) {
		providers.push(
			Discord({
				clientId: discordId,
				clientSecret: discordSecret,
				client: { token_endpoint_auth_method: 'client_secret_post' },
				profile: discordUserProfile,
				account: discardOAuthTokens
			})
		);
	}

	const devLoginEnabled = isDev && isEnvFlagOn(getEnv(event, 'AUTH_DEV_LOGIN'));
	if (devLoginEnabled) {
		providers.push(
			Credentials({
				credentials: {
					email: { label: 'Email', type: 'email' },
					name: { label: 'Name', type: 'text' }
				},
				async authorize(credentials) {
					const email = String(credentials?.email ?? '');
					const name = String(credentials?.name ?? '').trim() || 'Dev User';
					if (!email.trim()) return null;

					const resolved = await findOrCreateUserByEmail(db, { email, name });
					if (!resolved) return null;
					return { id: resolved.id, name: resolved.name, email: resolved.email };
				}
			})
		);
	}

	if (!isDev && providers.length === 0) {
		console.warn(
			'[auth] No OAuth providers configured. Set AUTH_GOOGLE_ID/AUTH_GOOGLE_SECRET or AUTH_DISCORD_ID/AUTH_DISCORD_SECRET to enable sign-in.'
		);
	}

	return {
		providers,
		adapter: createAuthAdapter(db),
		secret: authSecret,
		session: { strategy: 'jwt' },
		pages: {
			signIn: '/login'
		},
		callbacks: createAuthCallbacks(db),
		// trustHost defaults on; deployments running behind an untrusted proxy can
		// opt out with AUTH_TRUST_HOST=false (or 0/no/off). Cloudflare Pages strips
		// and rewrites the Host header, so the default is safe for this stack.
		trustHost: !isEnvFlagOff(getEnv(event, 'AUTH_TRUST_HOST'))
	};
});

function isEnvFlagOn(value: string | undefined): boolean {
	if (!value) return false;
	const v = value.trim().toLowerCase();
	return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function isEnvFlagOff(value: string | undefined): boolean {
	if (!value) return false;
	const v = value.trim().toLowerCase();
	return v === '0' || v === 'false' || v === 'no' || v === 'off';
}

export async function getUserId(event: RequestEvent): Promise<string | null> {
	const session = await event.locals.auth();
	return session?.user?.id ?? null;
}

export async function ensureUser(event: RequestEvent): Promise<string> {
	const userId = await getUserId(event);
	if (!userId) {
		throw error(401, 'Sign in required');
	}

	const db = await getDb(event);
	const existing = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get();
	if (!existing) throw error(401, 'Session is no longer valid');
	return existing.id;
}

type FindOrCreateInput = {
	email: string;
	name?: string | null;
	image?: string | null;
};

type ResolvedUser = {
	id: string;
	name: string | null;
	email: string;
	image: string | null;
};

/**
 * Resolve a user row by email, creating one if missing. Handles concurrent
 * first-sign-in races by retrying the lookup after a constraint violation.
 */
export async function findOrCreateUserByEmail(
	db: Awaited<ReturnType<typeof getDb>>,
	input: FindOrCreateInput
): Promise<ResolvedUser | null> {
	const email = input.email.trim().toLowerCase();

	const existing = await db
		.select({ id: users.id, name: users.name, email: users.email, image: users.image })
		.from(users)
		.where(eq(users.email, email))
		.get();
	if (existing && existing.email) {
		return existing as ResolvedUser;
	}

	const id = nanoid(21);
	try {
		await db.insert(users).values({
			id,
			name: input.name ?? null,
			email,
			image: input.image ?? null
		});
		return { id, name: input.name ?? null, email, image: input.image ?? null };
	} catch {
		const reread = await db
			.select({ id: users.id, name: users.name, email: users.email, image: users.image })
			.from(users)
			.where(eq(users.email, email))
			.get();
		if (reread && reread.email) return reread as ResolvedUser;
		return null;
	}
}
