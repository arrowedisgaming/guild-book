CREATE TABLE `campaign_adventurer_tenures` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`membership_id` text NOT NULL,
	`character_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`started_by_user_id` text,
	`ended_at` integer,
	`ended_by_user_id` text,
	`end_reason` text,
	`death_session_id` text,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`membership_id`) REFERENCES `campaign_members`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`started_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`ended_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "campaign_tenures_end_reason_check" CHECK("campaign_adventurer_tenures"."end_reason" IS NULL OR "campaign_adventurer_tenures"."end_reason" IN ('replaced', 'left', 'removed', 'died', 'corrected'))
);
--> statement-breakpoint
CREATE INDEX `campaign_tenures_campaign_idx` ON `campaign_adventurer_tenures` (`campaign_id`);--> statement-breakpoint
CREATE INDEX `campaign_tenures_membership_idx` ON `campaign_adventurer_tenures` (`membership_id`);--> statement-breakpoint
CREATE INDEX `campaign_tenures_character_idx` ON `campaign_adventurer_tenures` (`character_id`);--> statement-breakpoint
CREATE INDEX `campaign_tenures_started_by_user_idx` ON `campaign_adventurer_tenures` (`started_by_user_id`);--> statement-breakpoint
CREATE INDEX `campaign_tenures_ended_by_user_idx` ON `campaign_adventurer_tenures` (`ended_by_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_tenures_active_membership_uq` ON `campaign_adventurer_tenures` (`membership_id`) WHERE ended_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_tenures_active_character_uq` ON `campaign_adventurer_tenures` (`character_id`) WHERE ended_at IS NULL;--> statement-breakpoint
CREATE TABLE `campaign_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`campaign_id` text NOT NULL,
	`membership_id` text,
	`tenure_id` text,
	`character_id` text,
	`actor_user_id` text,
	`kind` text NOT NULL,
	`public_payload_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`membership_id`) REFERENCES `campaign_members`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`tenure_id`) REFERENCES `campaign_adventurer_tenures`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `campaign_events_campaign_cursor_idx` ON `campaign_events` (`campaign_id`,`id`);--> statement-breakpoint
CREATE INDEX `campaign_events_membership_idx` ON `campaign_events` (`membership_id`);--> statement-breakpoint
CREATE INDEX `campaign_events_tenure_idx` ON `campaign_events` (`tenure_id`);--> statement-breakpoint
CREATE INDEX `campaign_events_character_idx` ON `campaign_events` (`character_id`);--> statement-breakpoint
CREATE INDEX `campaign_events_actor_user_idx` ON `campaign_events` (`actor_user_id`);--> statement-breakpoint
CREATE TABLE `campaign_members` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`user_id` text NOT NULL,
	`joined_at` integer NOT NULL,
	`left_at` integer,
	`removed_at` integer,
	`removed_by_user_id` text,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`removed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `campaign_members_campaign_idx` ON `campaign_members` (`campaign_id`);--> statement-breakpoint
CREATE INDEX `campaign_members_user_idx` ON `campaign_members` (`user_id`);--> statement-breakpoint
CREATE INDEX `campaign_members_removed_by_user_idx` ON `campaign_members` (`removed_by_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_members_active_user_uq` ON `campaign_members` (`campaign_id`,`user_id`) WHERE left_at IS NULL;--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`invite_token_prefix` text,
	`invite_token_hash` text,
	`invite_nonce` text,
	`invite_version` integer DEFAULT 1 NOT NULL,
	`join_open` integer DEFAULT false NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "campaigns_invite_version_check" CHECK("campaigns"."invite_version" > 0),
	CONSTRAINT "campaigns_version_check" CHECK("campaigns"."version" > 0)
);
--> statement-breakpoint
CREATE INDEX `campaigns_owner_user_idx` ON `campaigns` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX `campaigns_invite_token_prefix_idx` ON `campaigns` (`invite_token_prefix`);--> statement-breakpoint
CREATE TABLE `guild_rosters` (
	`campaign_id` text PRIMARY KEY NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`document_json` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "guild_rosters_schema_version_check" CHECK("guild_rosters"."schema_version" > 0),
	CONSTRAINT "guild_rosters_version_check" CHECK("guild_rosters"."version" > 0)
);
