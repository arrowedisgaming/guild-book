ALTER TABLE `users` ADD `first_seen_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `last_seen_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `login_count` integer DEFAULT 0 NOT NULL;