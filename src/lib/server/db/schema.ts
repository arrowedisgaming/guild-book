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

// ─── Campaign foundation ─────────────────────────────────────────

/** A campaign has one immutable owner, who is the sole GM. */
export const campaigns = sqliteTable(
	'campaigns',
	{
		id: text('id').primaryKey(),
		ownerUserId: text('owner_user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		name: text('name').notNull().default(''),
		description: text('description').notNull().default(''),
		inviteTokenPrefix: text('invite_token_prefix'),
		inviteTokenHash: text('invite_token_hash'),
		inviteNonce: text('invite_nonce'),
		inviteVersion: integer('invite_version').notNull().default(1),
		joinOpen: integer('join_open', { mode: 'boolean' }).notNull().default(false),
		version: integer('version').notNull().default(1),
		archivedAt: integer('archived_at', { mode: 'timestamp' }),
		createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull()
	},
	(table) => [
		index('campaigns_owner_user_idx').on(table.ownerUserId),
		index('campaigns_invite_token_prefix_idx').on(table.inviteTokenPrefix),
		check('campaigns_invite_version_check', sql`${table.inviteVersion} > 0`),
		check('campaigns_version_check', sql`${table.version} > 0`)
	]
);

/**
 * A conditional lifecycle claim is inserted only while every command guard is
 * still true. The matching receipt has a foreign key to this row, so a
 * zero-row conditional claim aborts the whole SQLite transaction or D1 batch.
 */
export const campaignMutationClaims = sqliteTable(
	'campaign_mutation_claims',
	{
		id: text('id').primaryKey(),
		campaignId: text('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),
		characterId: text('character_id').references(() => characters.id, { onDelete: 'cascade' }),
		kind: text('kind').notNull(),
		actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
		createdAt: integer('created_at', { mode: 'timestamp' }).notNull()
	},
	(table) => [
		index('campaign_mutation_claims_campaign_idx').on(table.campaignId),
		index('campaign_mutation_claims_character_idx').on(table.characterId)
	]
);

/** Required foreign-key proof that a conditional lifecycle claim was won. */
export const campaignMutationReceipts = sqliteTable('campaign_mutation_receipts', {
	claimId: text('claim_id')
		.primaryKey()
		.references(() => campaignMutationClaims.id, { onDelete: 'cascade' })
});

/** The shared, owner-edited Guild Roster document for one campaign. */
export const guildRosters = sqliteTable(
	'guild_rosters',
	{
		campaignId: text('campaign_id')
			.primaryKey()
			.references(() => campaigns.id, { onDelete: 'cascade' }),
		schemaVersion: integer('schema_version').notNull().default(1),
		documentJson: text('document_json').notNull(),
		version: integer('version').notNull().default(1),
		createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull()
	},
	(table) => [
		check('guild_rosters_schema_version_check', sql`${table.schemaVersion} > 0`),
		check('guild_rosters_version_check', sql`${table.version} > 0`)
	]
);

/** A historical membership; active rows have no `leftAt`. */
export const campaignMembers = sqliteTable(
	'campaign_members',
	{
		id: text('id').primaryKey(),
		campaignId: text('campaign_id')
			.notNull()
			.references(() => campaigns.id, { onDelete: 'cascade' }),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		joinedAt: integer('joined_at', { mode: 'timestamp' }).notNull(),
		leftAt: integer('left_at', { mode: 'timestamp' }),
		removedAt: integer('removed_at', { mode: 'timestamp' }),
		removedByUserId: text('removed_by_user_id').references(() => users.id, {
			onDelete: 'set null'
		})
	},
	(table) => [
		index('campaign_members_campaign_idx').on(table.campaignId),
		index('campaign_members_user_idx').on(table.userId),
		index('campaign_members_removed_by_user_idx').on(table.removedByUserId),
		uniqueIndex('campaign_members_active_user_uq')
			.on(table.campaignId, table.userId)
			.where(sql`left_at IS NULL`)
	]
);

/** A character's historical attachment to one campaign membership. */
export const campaignAdventurerTenures = sqliteTable(
	'campaign_adventurer_tenures',
	{
		id: text('id').primaryKey(),
		campaignId: text('campaign_id')
			.notNull()
			.references(() => campaigns.id, { onDelete: 'cascade' }),
		membershipId: text('membership_id')
			.notNull()
			.references(() => campaignMembers.id, { onDelete: 'cascade' }),
		characterId: text('character_id')
			.notNull()
			.references(() => characters.id, { onDelete: 'cascade' }),
		startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
		startedByUserId: text('started_by_user_id').references(() => users.id, {
			onDelete: 'set null'
		}),
		endedAt: integer('ended_at', { mode: 'timestamp' }),
		endedByUserId: text('ended_by_user_id').references(() => users.id, {
			onDelete: 'set null'
		}),
		endReason: text('end_reason'),
		deathSessionId: text('death_session_id')
	},
	(table) => [
		index('campaign_tenures_campaign_idx').on(table.campaignId),
		index('campaign_tenures_membership_idx').on(table.membershipId),
		index('campaign_tenures_character_idx').on(table.characterId),
		index('campaign_tenures_started_by_user_idx').on(table.startedByUserId),
		index('campaign_tenures_ended_by_user_idx').on(table.endedByUserId),
		uniqueIndex('campaign_tenures_active_membership_uq')
			.on(table.membershipId)
			.where(sql`ended_at IS NULL`),
		uniqueIndex('campaign_tenures_active_character_uq')
			.on(table.characterId)
			.where(sql`ended_at IS NULL`),
		check(
			'campaign_tenures_end_reason_check',
			sql`${table.endReason} IS NULL OR ${table.endReason} IN ('replaced', 'left', 'removed', 'died', 'corrected')`
		)
	]
);

/** Monotonic, sanitized campaign lifecycle and synchronization events. */
export const campaignEvents = sqliteTable(
	'campaign_events',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		campaignId: text('campaign_id')
			.notNull()
			.references(() => campaigns.id, { onDelete: 'cascade' }),
		membershipId: text('membership_id').references(() => campaignMembers.id, {
			onDelete: 'set null'
		}),
		tenureId: text('tenure_id').references(() => campaignAdventurerTenures.id, {
			onDelete: 'set null'
		}),
		characterId: text('character_id').references(() => characters.id, { onDelete: 'set null' }),
		actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
		kind: text('kind').notNull(),
		publicPayloadJson: text('public_payload_json').notNull(),
		createdAt: integer('created_at', { mode: 'timestamp' }).notNull()
	},
	(table) => [
		index('campaign_events_campaign_cursor_idx').on(table.campaignId, table.id),
		index('campaign_events_membership_idx').on(table.membershipId),
		index('campaign_events_tenure_idx').on(table.tenureId),
		index('campaign_events_character_idx').on(table.characterId),
		index('campaign_events_actor_user_idx').on(table.actorUserId)
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
