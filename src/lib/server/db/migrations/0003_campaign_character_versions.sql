CREATE TABLE `character_version_claims` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`character_id` text NOT NULL,
	`resulting_version` integer NOT NULL,
	`mutation_kind` text NOT NULL,
	`actor_user_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `character_version_claims_character_version_uq` ON `character_version_claims` (`character_id`,`resulting_version`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_characters` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`kith` text DEFAULT '' NOT NULL,
	`path` text DEFAULT '' NOT NULL,
	`data` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`life_status` text DEFAULT 'alive' NOT NULL,
	`is_draft` integer DEFAULT true NOT NULL,
	`is_archived` integer DEFAULT false NOT NULL,
	`share_id` text,
	`is_public` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "characters_life_status_check" CHECK("life_status" IN ('alive', 'dead'))
);
--> statement-breakpoint
INSERT INTO `__new_characters`("id", "user_id", "name", "kith", "path", "data", "version", "life_status", "is_draft", "is_archived", "share_id", "is_public", "created_at", "updated_at") SELECT "id", "user_id", "name", "kith", "path", "data", 1, 'alive', "is_draft", "is_archived", "share_id", "is_public", "created_at", "updated_at" FROM `characters`;--> statement-breakpoint
DROP TABLE `characters`;--> statement-breakpoint
ALTER TABLE `__new_characters` RENAME TO `characters`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `characters_share_id_unique` ON `characters` (`share_id`);--> statement-breakpoint
CREATE INDEX `characters_user_id_idx` ON `characters` (`user_id`);--> statement-breakpoint
CREATE INDEX `characters_share_id_idx` ON `characters` (`share_id`);--> statement-breakpoint
INSERT INTO `character_version_claims` (`character_id`, `resulting_version`, `mutation_kind`, `actor_user_id`, `created_at`)
SELECT `id`, 1, 'migration', NULL, `created_at` FROM `characters`;
