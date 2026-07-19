CREATE TABLE `campaign_mutation_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text,
	`character_id` text,
	`kind` text NOT NULL,
	`actor_user_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `campaign_mutation_claims_campaign_idx` ON `campaign_mutation_claims` (`campaign_id`);--> statement-breakpoint
CREATE INDEX `campaign_mutation_claims_character_idx` ON `campaign_mutation_claims` (`character_id`);--> statement-breakpoint
CREATE TABLE `campaign_mutation_receipts` (
	`claim_id` text PRIMARY KEY NOT NULL,
	FOREIGN KEY (`claim_id`) REFERENCES `campaign_mutation_claims`(`id`) ON UPDATE no action ON DELETE cascade
);
