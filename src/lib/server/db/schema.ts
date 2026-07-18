import { sqliteTable, text, integer, index, uniqueIndex, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// ─── Auth.js tables ───────────────────────────────────────────────
// Copied verbatim from the standard Auth.js Drizzle schema. `sessions` and
// `verification_tokens` are unused under the JWT strategy but kept for adapter
// compatibility and future email auth.

export const users = sqliteTable('users', {
	id: text('id').primaryKey(),
	name: text('name'),
	email: text('email').unique(),
	emailVerified: integer('email_verified', { mode: 'timestamp' }),
	image: text('image')
});

export const accounts = sqliteTable('accounts', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	type: text('type').notNull(),
	provider: text('provider').notNull(),
	providerAccountId: text('provider_account_id').notNull(),
	refresh_token: text('refresh_token'),
	access_token: text('access_token'),
	expires_at: integer('expires_at'),
	token_type: text('token_type'),
	scope: text('scope'),
	id_token: text('id_token'),
	session_state: text('session_state')
});

export const sessions = sqliteTable('sessions', {
	sessionToken: text('session_token').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	expires: integer('expires', { mode: 'timestamp' }).notNull()
});

export const verificationTokens = sqliteTable('verification_tokens', {
	identifier: text('identifier').notNull(),
	token: text('token').notNull(),
	expires: integer('expires', { mode: 'timestamp' }).notNull()
});

// ─── Application tables ──────────────────────────────────────────

/**
 * An adventurer. Denormalised `name`/`kith`/`path` columns make listing cheap;
 * the full `GuildBookCharacterData` lives in the `data` JSON blob (source of
 * truth). `shareId` + `isPublic` back read-only public sharing.
 */
export const characters = sqliteTable(
	'characters',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		name: text('name').notNull().default(''),
		kith: text('kith').notNull().default(''),
		path: text('path').notNull().default(''),
		/** Full GuildBookCharacterData as JSON blob. */
		data: text('data').notNull(),
		version: integer('version').notNull().default(1),
		lifeStatus: text('life_status').notNull().default('alive'),
		isDraft: integer('is_draft', { mode: 'boolean' }).notNull().default(true),
		isArchived: integer('is_archived', { mode: 'boolean' }).notNull().default(false),
		shareId: text('share_id').unique(),
		isPublic: integer('is_public', { mode: 'boolean' }).notNull().default(false),
		createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull()
	},
	(table) => [
		index('characters_user_id_idx').on(table.userId),
		index('characters_share_id_idx').on(table.shareId),
		check('characters_life_status_check', sql`${table.lifeStatus} IN ('alive', 'dead')`)
	]
);

/** Append-only claims proving every successful character document version. */
export const characterVersionClaims = sqliteTable(
	'character_version_claims',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		characterId: text('character_id')
			.notNull()
			.references(() => characters.id, { onDelete: 'cascade' }),
		resultingVersion: integer('resulting_version').notNull(),
		mutationKind: text('mutation_kind').notNull(),
		actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
		createdAt: integer('created_at', { mode: 'timestamp' }).notNull()
	},
	(table) => [
		uniqueIndex('character_version_claims_character_version_uq').on(
			table.characterId,
			table.resultingVersion
		)
	]
);

// ─── Guilds (schema-only; multiplayer UI deferred to a later phase) ─
// These tables are defined now so the initial migration is clean and no
// destructive migration is needed when the guild/multiplayer layer is built.
// No routes read or write them yet. Adapted from MUR's campaign tables.

/** A guild is a guildmaster-owned roster players join with a character. */
export const guilds = sqliteTable(
	'guilds',
	{
		id: text('id').primaryKey(),
		guildmasterUserId: text('guildmaster_user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		name: text('name').notNull().default(''),
		description: text('description').notNull().default(''),
		sigil: text('sigil').notNull().default(''),
		shareId: text('share_id').unique(),
		isOpen: integer('is_open', { mode: 'boolean' }).notNull().default(true),
		createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull()
	},
	(table) => [
		index('guilds_guildmaster_idx').on(table.guildmasterUserId),
		index('guilds_share_id_idx').on(table.shareId)
	]
);

/**
 * One row per (player, character) joined to a guild. `leftAt` is a soft-leave
 * timestamp; active membership = `left_at IS NULL`. Partial unique indexes fire
 * only on active rows so a character can re-join after leaving.
 */
export const guildMembers = sqliteTable(
	'guild_members',
	{
		id: text('id').primaryKey(),
		guildId: text('guild_id')
			.notNull()
			.references(() => guilds.id, { onDelete: 'cascade' }),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		characterId: text('character_id')
			.notNull()
			.references(() => characters.id, { onDelete: 'cascade' }),
		role: text('role').notNull().default(''),
		marchingOrder: integer('marching_order'),
		joinedAt: integer('joined_at', { mode: 'timestamp' }).notNull(),
		leftAt: integer('left_at', { mode: 'timestamp' })
	},
	(table) => [
		index('guild_members_guild_idx').on(table.guildId),
		index('guild_members_user_idx').on(table.userId),
		index('guild_members_character_idx').on(table.characterId),
		uniqueIndex('guild_members_character_active_uq')
			.on(table.guildId, table.characterId)
			.where(sql`left_at IS NULL`),
		uniqueIndex('guild_members_user_active_uq')
			.on(table.guildId, table.userId)
			.where(sql`left_at IS NULL`)
	]
);

/**
 * Append-only shared tarot-draw log for a guild. Autoincrement `id` is a
 * strictly-monotonic cursor for `?since=<id>` polling. `userId`/`characterId`
 * are nullable + set-null on delete so the log survives deletions;
 * `characterName` is a denormalised snapshot for display after the FK breaks.
 * `entry` is a JSON-encoded tarot DrawResult.
 */
export const guildDraws = sqliteTable(
	'guild_draws',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		guildId: text('guild_id')
			.notNull()
			.references(() => guilds.id, { onDelete: 'cascade' }),
		userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
		characterId: text('character_id').references(() => characters.id, { onDelete: 'set null' }),
		characterName: text('character_name').notNull(),
		entry: text('entry').notNull(),
		createdAt: integer('created_at', { mode: 'timestamp' }).notNull()
	},
	(table) => [index('guild_draws_guild_id_idx').on(table.guildId, table.id)]
);
