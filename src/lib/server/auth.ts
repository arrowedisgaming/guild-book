import { error, type RequestEvent } from '@sveltejs/kit';
import { SvelteKitAuth } from '@auth/sveltekit';
import Google from '@auth/sveltekit/providers/google';
import Discord from '@auth/sveltekit/providers/discord';
import Credentials from '@auth/sveltekit/providers/credentials';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { getDb } from './db';
import { accounts, users } from './db/schema';

type EnvPlatform = {
	env?: Record<string, string | D1Database | undefined>;
};

export const DEV_AUTH_SECRET = 'guild-book-local-development-secret';

/** Read a server-only setting from Cloudflare bindings or the Node environment. */
export function getEnv(event: RequestEvent, key: string): string | undefined {
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

	const providers = [];

	if (googleId && googleSecret) {
		providers.push(
			Google({
				clientId: googleId,
				clientSecret: googleSecret
			})
		);
	}

	if (discordId && discordSecret) {
		providers.push(
			Discord({
				clientId: discordId,
				clientSecret: discordSecret,
				client: { token_endpoint_auth_method: 'client_secret_post' }
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
					const email = String(credentials?.email ?? '').trim();
					const name = String(credentials?.name ?? '').trim() || 'Dev User';
					if (!email) return null;

					const db = await getDb(event);
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
		secret: authSecret,
		session: { strategy: 'jwt' },
		pages: {
			signIn: '/login'
		},
		callbacks: {
			async jwt({ token, user, account, profile }) {
				// Resolve the DB row id whenever Auth.js gives us an account (initial
				// sign-in / provider re-entry). Character ownership must use the local
				// users.id value returned by our account-linking logic, not the OAuth sub.
				if (account) {
					if (account.provider === 'credentials' && user?.id) {
						token.id = user.id;
					} else {
						const db = await getDb(event);
						const email = (user?.email ?? token.email ?? null) as string | null;
						const emailVerified = isProfileEmailVerified(account.provider, profile);

						const resolved = await findOrLinkOAuthAccount(db, {
							provider: account.provider,
							providerAccountId: account.providerAccountId,
							email,
							emailVerified,
							name: user?.name ?? null,
							image: user?.image ?? null
						});
						if (resolved) {
							token.id = resolved.id;
						} else if (user?.id) {
							token.id = user.id;
						}
					}
				}
				return token;
			},
			session({ session, token }) {
				if (session.user && token.id) {
					session.user.id = String(token.id);
				}
				return session;
			}
		},
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

function isProfileEmailVerified(provider: string, profile: unknown): boolean {
	if (!profile || typeof profile !== 'object') return false;
	const p = profile as Record<string, unknown>;
	if (provider === 'google') return p.email_verified === true;
	if (provider === 'discord') return p.verified === true;
	return false;
}

export async function getUserId(event: RequestEvent): Promise<string | null> {
	const session = await event.locals.auth();
	return session?.user?.id ?? null;
}

export async function ensureUser(event: RequestEvent): Promise<string> {
	const session = await event.locals.auth();
	const userId = session?.user?.id;
	if (!userId) {
		throw error(401, 'Sign in required');
	}

	const db = await getDb(event);
	const existing = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get();
	if (existing) return existing.id;

	// Legacy fallback: resolve via email so already-signed-in users keep working
	// until their JWT naturally rotates.
	const email = session.user?.email;
	if (email) {
		const byEmail = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.email, email))
			.get();
		if (byEmail) return byEmail.id;
	}

	throw error(401, 'Session is no longer valid');
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

type LinkOAuthInput = {
	provider: string;
	providerAccountId: string;
	email: string | null;
	emailVerified: boolean;
	name: string | null;
	image: string | null;
};

/**
 * Resolve a user for an OAuth sign-in.
 *
 * Lookup order:
 *  1. Existing accounts row matching (provider, providerAccountId) — same identity, just return it.
 *  2. If the provider reports the email as verified, fall back to email-merge so users
 *     with a pre-existing row don't get duplicated on first OAuth link.
 *  3. Otherwise create a fresh user with no email merge (avoids account takeover via
 *     unverified-email providers).
 *
 * In all OAuth paths, the accounts row is upserted so future sign-ins hit step 1.
 */
export async function findOrLinkOAuthAccount(
	db: Awaited<ReturnType<typeof getDb>>,
	input: LinkOAuthInput
): Promise<ResolvedUser | null> {
	const existingAccount = await db
		.select({ userId: accounts.userId })
		.from(accounts)
		.where(
			and(
				eq(accounts.provider, input.provider),
				eq(accounts.providerAccountId, input.providerAccountId)
			)
		)
		.get();

	if (existingAccount) {
		const user = await db
			.select({ id: users.id, name: users.name, email: users.email, image: users.image })
			.from(users)
			.where(eq(users.id, existingAccount.userId))
			.get();
		if (user) {
			return {
				id: user.id,
				name: user.name ?? null,
				email: user.email ?? '',
				image: user.image ?? null
			};
		}
	}

	let userId: string | null = null;

	if (input.email && input.emailVerified) {
		const byEmail = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.email, input.email))
			.get();
		if (byEmail) userId = byEmail.id;
	}

	if (!userId) {
		// Only persist the email on the user row if the provider verified it.
		// An unverified email could collide with an existing verified user via
		// the users.email UNIQUE index, which would silently merge the two —
		// the exact takeover path we're guarding against.
		const persistEmail = input.email && input.emailVerified ? input.email : null;
		userId = nanoid(21);
		try {
			await db.insert(users).values({
				id: userId,
				name: input.name ?? null,
				email: persistEmail,
				image: input.image ?? null
			});
		} catch {
			if (persistEmail) {
				const reread = await db
					.select({ id: users.id })
					.from(users)
					.where(eq(users.email, persistEmail))
					.get();
				if (reread) userId = reread.id;
				else return null;
			} else {
				return null;
			}
		}
	}

	try {
		await db.insert(accounts).values({
			id: nanoid(21),
			userId,
			type: 'oauth',
			provider: input.provider,
			providerAccountId: input.providerAccountId
		});
	} catch {
		// Race or pre-existing identical row — safe to ignore.
	}

	const finalUser = await db
		.select({ id: users.id, name: users.name, email: users.email, image: users.image })
		.from(users)
		.where(eq(users.id, userId))
		.get();
	if (!finalUser) return null;
	return {
		id: finalUser.id,
		name: finalUser.name ?? null,
		email: finalUser.email ?? '',
		image: finalUser.image ?? null
	};
}

/**
 * Resolve a user row by email, creating one if missing. Handles concurrent
 * first-sign-in races by retrying the lookup after a constraint violation.
 */
export async function findOrCreateUserByEmail(
	db: Awaited<ReturnType<typeof getDb>>,
	input: FindOrCreateInput
): Promise<ResolvedUser | null> {
	const email = input.email;

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
