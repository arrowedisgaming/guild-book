CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`provider` text NOT NULL,
	`provider_account_id` text NOT NULL,
	`refresh_token` text,
	`access_token` text,
	`expires_at` integer,
	`token_type` text,
	`scope` text,
	`id_token` text,
	`session_state` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `characters` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`kith` text DEFAULT '' NOT NULL,
	`path` text DEFAULT '' NOT NULL,
	`data` text NOT NULL,
	`is_draft` integer DEFAULT true NOT NULL,
	`is_archived` integer DEFAULT false NOT NULL,
	`share_id` text,
	`is_public` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `characters_share_id_unique` ON `characters` (`share_id`);--> statement-breakpoint
CREATE INDEX `characters_user_id_idx` ON `characters` (`user_id`);--> statement-breakpoint
CREATE INDEX `characters_share_id_idx` ON `characters` (`share_id`);--> statement-breakpoint
CREATE TABLE `guild_draws` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`user_id` text,
	`character_id` text,
	`character_name` text NOT NULL,
	`entry` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `guild_draws_guild_id_idx` ON `guild_draws` (`guild_id`,`id`);--> statement-breakpoint
CREATE TABLE `guild_members` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`character_id` text NOT NULL,
	`role` text DEFAULT '' NOT NULL,
	`marching_order` integer,
	`joined_at` integer NOT NULL,
	`left_at` integer,
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `guild_members_guild_idx` ON `guild_members` (`guild_id`);--> statement-breakpoint
CREATE INDEX `guild_members_user_idx` ON `guild_members` (`user_id`);--> statement-breakpoint
CREATE INDEX `guild_members_character_idx` ON `guild_members` (`character_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `guild_members_character_active_uq` ON `guild_members` (`guild_id`,`character_id`) WHERE left_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `guild_members_user_active_uq` ON `guild_members` (`guild_id`,`user_id`) WHERE left_at IS NULL;--> statement-breakpoint
CREATE TABLE `guilds` (
	`id` text PRIMARY KEY NOT NULL,
	`guildmaster_user_id` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`sigil` text DEFAULT '' NOT NULL,
	`share_id` text,
	`is_open` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`guildmaster_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `guilds_share_id_unique` ON `guilds` (`share_id`);--> statement-breakpoint
CREATE INDEX `guilds_guildmaster_idx` ON `guilds` (`guildmaster_user_id`);--> statement-breakpoint
CREATE INDEX `guilds_share_id_idx` ON `guilds` (`share_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`session_token` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`email` text,
	`email_verified` integer,
	`image` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `verification_tokens` (
	`identifier` text NOT NULL,
	`token` text NOT NULL,
	`expires` integer NOT NULL
);
