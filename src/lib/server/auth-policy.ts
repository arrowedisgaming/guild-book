import type { AuthConfig } from '@auth/core';
import type { DiscordProfile } from '@auth/core/providers/discord';
import type { GoogleProfile } from '@auth/core/providers/google';
import { eq } from 'drizzle-orm';
import type { AppDb } from './db';
import { users } from './db/schema';
import { activityPatch, type ActivityState } from './admin/activity';

export const AUTH_SESSION_VERSION = 2;

/**
 * Best-effort beta activity write. Failure is swallowed on purpose: the caller
 * is the `jwt` callback, and throwing (or letting a rejection escape) there
 * would invalidate the token and sign the user out. No analytics figure is
 * worth that.
 */
async function recordActivity(
	db: AppDb,
	userId: string,
	isSignIn: boolean,
	current: ActivityState
): Promise<void> {
	try {
		const patch = activityPatch({ now: new Date(), isSignIn, current });
		if (!patch) return;
		await db.update(users).set(patch).where(eq(users.id, userId));
	} catch (err) {
		console.warn('[auth] activity write failed:', (err as Error)?.message ?? err);
	}
}

/** Shared verbatim with the Auth.js lifecycle integration tests. */
export function createAuthCallbacks(db: AppDb): NonNullable<AuthConfig['callbacks']> {
	return {
		async jwt({ token, user }) {
			if (user?.id) {
				// With the adapter, Auth.js supplies the durable local users.id.
				token.sub = user.id;
				token.sessionVersion = AUTH_SESSION_VERSION;
				// A sign-in happens at most once per token lifetime, so the extra
				// read here is cheap and keeps every decision in the tested pure
				// function rather than splitting it across SQL expressions.
				const current = await db
					.select({
						firstSeenAt: users.firstSeenAt,
						lastSeenAt: users.lastSeenAt,
						loginCount: users.loginCount
					})
					.from(users)
					.where(eq(users.id, user.id))
					.get();
				await recordActivity(
					db,
					user.id,
					true,
					current ?? { firstSeenAt: null, lastSeenAt: null, loginCount: 0 }
				);
			} else if (token.sessionVersion !== AUTH_SESSION_VERSION) {
				// Invalidate legacy JWTs whose `sub` held the provider account id.
				// Rotating AUTH_SECRET at rollout remains recommended, but correctness
				// does not depend on that operational step.
				return null;
			} else if (token.sub) {
				// A signed JWT must not outlive its durable local user. This also keeps
				// the application shell and protected API routes in agreement after an
				// account is removed. The activity columns ride along on this
				// already-required lookup, so tracking costs no extra query.
				const existing = await db
					.select({
						id: users.id,
						firstSeenAt: users.firstSeenAt,
						lastSeenAt: users.lastSeenAt,
						loginCount: users.loginCount
					})
					.from(users)
					.where(eq(users.id, token.sub))
					.get();
				if (!existing) return null;
				await recordActivity(db, existing.id, false, existing);
			}
			return token;
		},
		session({ session, token }) {
			if (session.user && token.sub) session.user.id = token.sub;
			return session;
		}
	};
}

/**
 * Return an OAuth email only when the provider explicitly verifies it. The
 * user may still authenticate with an unverified provider account; storing a
 * null email prevents that account from reserving or colliding with a verified
 * users.email value.
 */
export function verifiedProviderEmail(provider: string, profile: unknown): string | null {
	if (!profile || typeof profile !== 'object') return null;

	const claims = profile as Record<string, unknown>;
	const verified =
		(provider === 'google' && claims.email_verified === true) ||
		(provider === 'discord' && claims.verified === true);
	if (!verified || typeof claims.email !== 'string') return null;

	const email = claims.email.trim().toLowerCase();
	return email || null;
}

export function googleUserProfile(profile: GoogleProfile) {
	return {
		id: profile.sub,
		name: profile.name,
		email: verifiedProviderEmail('google', profile),
		image: profile.picture
	};
}

/** Auth.js' standard Discord profile mapping with verified-email persistence. */
export function discordUserProfile(profile: DiscordProfile) {
	let image: string;
	if (profile.avatar === null) {
		const defaultAvatarNumber =
			profile.discriminator === '0'
				? Number(BigInt(profile.id) >> BigInt(22)) % 6
				: Number.parseInt(profile.discriminator, 10) % 5;
		image = `https://cdn.discordapp.com/embed/avatars/${defaultAvatarNumber}.png`;
	} else {
		const format = profile.avatar.startsWith('a_') ? 'gif' : 'png';
		image = `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.${format}`;
	}

	return {
		id: profile.id,
		name: profile.global_name ?? profile.username,
		email: verifiedProviderEmail('discord', profile),
		image
	};
}
