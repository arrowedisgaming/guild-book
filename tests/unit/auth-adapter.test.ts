import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from '$lib/server/db/schema';
import type { AppDb } from '$lib/server/db';
import { createAuthAdapter, discardOAuthTokens } from '$lib/server/auth-adapter';
import {
	AUTH_SESSION_VERSION,
	discordUserProfile,
	googleUserProfile,
	verifiedProviderEmail
} from '$lib/server/auth-policy';

const { accounts, users } = schema;
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

describe('Auth.js account adapter', () => {
	let sqlite: Database.Database;
	let db: AppDb;

	beforeEach(() => {
		sqlite = new Database(':memory:');
		sqlite.pragma('foreign_keys = ON');
		sqlite.exec(baseMigration);
		sqlite.exec(authMigration);
		sqlite.exec(normalizedEmailMigration);
		db = drizzle(sqlite, { schema });
	});

	afterEach(() => sqlite.close());

	it('stores two providers against one durable local user', async () => {
		const adapter = createAuthAdapter(db);
		await adapter.createUser!({
			id: 'local-user',
			name: 'Worm Knight',
			email: 'knight@example.com',
			emailVerified: null,
			image: null
		});

		await adapter.linkAccount!({
			userId: 'local-user',
			type: 'oidc',
			provider: 'google',
			providerAccountId: 'google-sub'
		});
		await adapter.linkAccount!({
			userId: 'local-user',
			type: 'oauth',
			provider: 'discord',
			providerAccountId: 'discord-id'
		});

		await expect(
			adapter.getUserByAccount!({ provider: 'google', providerAccountId: 'google-sub' })
		).resolves.toMatchObject({ id: 'local-user' });
		await expect(
			adapter.getUserByAccount!({ provider: 'discord', providerAccountId: 'discord-id' })
		).resolves.toMatchObject({ id: 'local-user' });

		const rows = await db.select().from(accounts);
		expect(rows).toHaveLength(2);
		expect(rows.every((row) => row.id.length === 21)).toBe(true);
	});

	it('allows only one owner for a provider identity under a concurrent link race', async () => {
		const adapter = createAuthAdapter(db);
		await Promise.all(
			['user-a', 'user-b'].map((id) =>
				adapter.createUser!({ id, name: id, email: `${id}@example.com`, emailVerified: null, image: null })
			)
		);

		const results = await Promise.allSettled(
			['user-a', 'user-b'].map((userId) =>
				adapter.linkAccount!({
					userId,
					type: 'oauth',
					provider: 'discord',
					providerAccountId: 'one-discord-user'
				})
			)
		);

		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
		const rows = await db
			.select()
			.from(accounts)
			.where(eq(accounts.providerAccountId, 'one-discord-user'));
		expect(rows).toHaveLength(1);
	});

	it('does not retain OAuth bearer or refresh tokens', () => {
		expect(
			discardOAuthTokens({ access_token: 'secret-access', refresh_token: 'secret-refresh' })
		).toEqual({});
	});

	it('rejects mixed-case duplicates at the database boundary', async () => {
		const adapter = createAuthAdapter(db);
		await adapter.createUser!({
			id: 'first-user',
			name: 'First User',
			email: 'user@example.com',
			emailVerified: null,
			image: null
		});

		await expect(
			adapter.createUser!({
				id: 'second-user',
				name: 'Second User',
				email: 'User@Example.com',
				emailVerified: null,
				image: null
			})
		).rejects.toThrow();
	});

	it('persists only verified provider emails without denying the identity', () => {
		expect(
			googleUserProfile({
				sub: 'google-id',
				name: 'Google User',
				email: 'User@Example.com',
				email_verified: false,
				picture: 'https://example.com/avatar.png'
			} as never)
		).toMatchObject({ id: 'google-id', email: null });
		expect(verifiedProviderEmail('google', { email: 'User@Example.com', email_verified: true })).toBe(
			'user@example.com'
		);
		expect(
			discordUserProfile({
				id: '123456789',
				username: 'discord-user',
				global_name: null,
				discriminator: '0',
				avatar: null,
				email: 'discord@example.com',
				verified: false
			} as never)
		).toMatchObject({ id: '123456789', email: null });
		expect(verifiedProviderEmail('discord', null)).toBeNull();
		expect(AUTH_SESSION_VERSION).toBe(2);
	});
});

describe('auth account migration guards', () => {
	it('fails before normalizing case-colliding legacy emails', () => {
		const sqlite = new Database(':memory:');
		try {
			sqlite.exec(baseMigration);
			sqlite
				.prepare('INSERT INTO users (id, email) VALUES (?, ?), (?, ?)')
				.run('user-a', 'A@Example.com', 'user-b', 'a@example.com');

			expect(() => sqlite.exec(authMigration)).toThrow();
			const emails = sqlite
				.prepare('SELECT email FROM users ORDER BY id')
				.all() as Array<{ email: string }>;
			expect(emails.map(({ email }) => email)).toEqual(['A@Example.com', 'a@example.com']);
		} finally {
			sqlite.close();
		}
	});

	it('fails before email mutation when a provider identity has two owners', () => {
		const sqlite = new Database(':memory:');
		try {
			sqlite.exec(baseMigration);
			sqlite.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run('user-a', 'A@Example.com');
			const insertAccount = sqlite.prepare(
				'INSERT INTO accounts (id, user_id, type, provider, provider_account_id) VALUES (?, ?, ?, ?, ?)'
			);
			insertAccount.run('account-a', 'user-a', 'oauth', 'discord', 'same-id');
			sqlite.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run('user-b', 'b@example.com');
			insertAccount.run('account-b', 'user-b', 'oauth', 'discord', 'same-id');

			expect(() => sqlite.exec(authMigration)).toThrow();
			expect(sqlite.prepare('SELECT email FROM users WHERE id = ?').pluck().get('user-a')).toBe(
				'A@Example.com'
			);
		} finally {
			sqlite.close();
		}
	});
});
