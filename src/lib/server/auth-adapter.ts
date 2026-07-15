import type { Adapter } from '@auth/core/adapters';
import type { TokenSet } from '@auth/core/types';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import type { AppDb } from './db';
import { accounts, sessions, users, verificationTokens } from './db/schema';

/**
 * Auth.js adapter bound to Guild Book's request-specific SQLite/D1 database.
 * JWT sessions are still used, but the adapter owns durable user/account
 * identity and Auth.js' authenticated account-linking lifecycle.
 */
export function createAuthAdapter(db: AppDb): Adapter {
	return DrizzleAdapter(db, {
		usersTable: users,
		accountsTable: accounts,
		sessionsTable: sessions,
		verificationTokensTable: verificationTokens
	});
}

/**
 * Guild Book uses OAuth only for authentication, never to call provider APIs.
 * Auth.js adds provider/type/providerAccountId/userId after this callback, so
 * returning an empty token set avoids persisting bearer and refresh tokens.
 */
export function discardOAuthTokens(_tokens: TokenSet): TokenSet {
	return {};
}
