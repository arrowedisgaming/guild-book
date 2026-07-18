CREATE TABLE `campaign_event_secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` integer NOT NULL,
	`recipient_user_id` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `campaign_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipient_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `campaign_event_secrets_event_idx` ON `campaign_event_secrets` (`event_id`);--> statement-breakpoint
CREATE INDEX `campaign_event_secrets_recipient_idx` ON `campaign_event_secrets` (`recipient_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_event_secrets_event_recipient_uq` ON `campaign_event_secrets` (`event_id`,`recipient_user_id`);--> statement-breakpoint
CREATE TABLE `play_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`status` text NOT NULL,
	`phase` text NOT NULL,
	`procedure_id` text,
	`content_pack_id` text NOT NULL,
	`content_pack_version` text NOT NULL,
	`procedure_schema_version` integer DEFAULT 1 NOT NULL,
	`content_digest` text NOT NULL,
	`runtime_content_id` text,
	`version` integer DEFAULT 0 NOT NULL,
	`public_state_schema_version` integer DEFAULT 1 NOT NULL,
	`public_state_json` text NOT NULL,
	`started_at` integer NOT NULL,
	`started_by_user_id` text,
	`ended_at` integer,
	`ended_by_user_id` text,
	`final_public_state_json` text,
	`public_history_checksum` text,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`runtime_content_id`) REFERENCES `session_runtime_contents`(`session_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`started_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`ended_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "play_sessions_status_check" CHECK("play_sessions"."status" IN ('active', 'ended', 'frozen')),
	CONSTRAINT "play_sessions_phase_check" CHECK("play_sessions"."phase" IN ('crawl', 'challenge', 'camp', 'city')),
	CONSTRAINT "play_sessions_sequence_check" CHECK("play_sessions"."sequence" >= 0),
	CONSTRAINT "play_sessions_version_check" CHECK("play_sessions"."version" >= 0),
	CONSTRAINT "play_sessions_procedure_schema_version_check" CHECK("play_sessions"."procedure_schema_version" > 0),
	CONSTRAINT "play_sessions_public_state_schema_version_check" CHECK("play_sessions"."public_state_schema_version" > 0)
);
--> statement-breakpoint
CREATE INDEX `play_sessions_campaign_idx` ON `play_sessions` (`campaign_id`);--> statement-breakpoint
CREATE INDEX `play_sessions_started_by_user_idx` ON `play_sessions` (`started_by_user_id`);--> statement-breakpoint
CREATE INDEX `play_sessions_ended_by_user_idx` ON `play_sessions` (`ended_by_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `play_sessions_open_campaign_uq` ON `play_sessions` (`campaign_id`) WHERE status IN ('active', 'frozen');--> statement-breakpoint
CREATE TABLE `session_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`command_id` text NOT NULL,
	`actor_user_id` text,
	`request_hash` text NOT NULL,
	`command_type` text NOT NULL,
	`client_observed_version` integer NOT NULL,
	`structural_precondition_version` integer,
	`expected_version` integer NOT NULL,
	`resulting_version` integer,
	`status` text NOT NULL,
	`outcome_metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `play_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "session_commands_status_check" CHECK("session_commands"."status" IN ('accepted', 'rejected')),
	CONSTRAINT "session_commands_resulting_version_check" CHECK("session_commands"."resulting_version" IS NULL OR "session_commands"."resulting_version" = "session_commands"."expected_version" + 1),
	CONSTRAINT "session_commands_status_resulting_version_check" CHECK(("session_commands"."status" = 'accepted' AND "session_commands"."resulting_version" IS NOT NULL) OR ("session_commands"."status" = 'rejected' AND "session_commands"."resulting_version" IS NULL)),
	CONSTRAINT "session_commands_client_observed_version_check" CHECK("session_commands"."client_observed_version" >= 0),
	CONSTRAINT "session_commands_structural_precondition_version_check" CHECK("session_commands"."structural_precondition_version" IS NULL OR "session_commands"."structural_precondition_version" >= 0),
	CONSTRAINT "session_commands_expected_version_check" CHECK("session_commands"."expected_version" >= 0)
);
--> statement-breakpoint
CREATE INDEX `session_commands_session_idx` ON `session_commands` (`session_id`);--> statement-breakpoint
CREATE INDEX `session_commands_actor_user_idx` ON `session_commands` (`actor_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_commands_session_command_uq` ON `session_commands` (`session_id`,`command_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_commands_resulting_version_uq` ON `session_commands` (`session_id`,`resulting_version`) WHERE resulting_version IS NOT NULL;--> statement-breakpoint
CREATE TABLE `session_private_states` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`recipient_user_id` text NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`session_version` integer NOT NULL,
	`private_state_json` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `play_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipient_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "session_private_states_schema_version_check" CHECK("session_private_states"."schema_version" > 0),
	CONSTRAINT "session_private_states_session_version_check" CHECK("session_private_states"."session_version" >= 0)
);
--> statement-breakpoint
CREATE INDEX `session_private_states_session_idx` ON `session_private_states` (`session_id`);--> statement-breakpoint
CREATE INDEX `session_private_states_recipient_idx` ON `session_private_states` (`recipient_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_private_states_session_recipient_uq` ON `session_private_states` (`session_id`,`recipient_user_id`);--> statement-breakpoint
CREATE TABLE `session_runtime_contents` (
	`session_id` text PRIMARY KEY NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`session_version` integer DEFAULT 0 NOT NULL,
	`runtime_content_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `play_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "session_runtime_contents_schema_version_check" CHECK("session_runtime_contents"."schema_version" > 0),
	CONSTRAINT "session_runtime_contents_session_version_check" CHECK("session_runtime_contents"."session_version" >= 0)
);
--> statement-breakpoint
CREATE TABLE `session_server_states` (
	`session_id` text PRIMARY KEY NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`session_version` integer NOT NULL,
	`server_state_json` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `play_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "session_server_states_schema_version_check" CHECK("session_server_states"."schema_version" > 0),
	CONSTRAINT "session_server_states_session_version_check" CHECK("session_server_states"."session_version" >= 0)
);
--> statement-breakpoint
ALTER TABLE `campaign_events` ADD `session_id` text REFERENCES play_sessions(id);--> statement-breakpoint
ALTER TABLE `campaign_events` ADD `command_id` text REFERENCES session_commands(id);--> statement-breakpoint
CREATE INDEX `campaign_events_session_idx` ON `campaign_events` (`session_id`);--> statement-breakpoint
CREATE INDEX `campaign_events_command_idx` ON `campaign_events` (`command_id`);