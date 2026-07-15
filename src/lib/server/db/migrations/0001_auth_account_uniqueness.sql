-- Fail before mutating rows if legacy email casing would collapse two users.
-- This makes the README preflight helpful rather than load-bearing.
CREATE UNIQUE INDEX IF NOT EXISTS `users_normalized_email_migration_guard_uq`
	ON `users` (LOWER(TRIM(`email`))) WHERE `email` IS NOT NULL;
--> statement-breakpoint
-- Likewise, install the safety-critical provider constraint before changing
-- email data. Existing duplicate identities make the migration fail closed.
CREATE UNIQUE INDEX IF NOT EXISTS `accounts_provider_identity_uq`
	ON `accounts` (`provider`,`provider_account_id`);
--> statement-breakpoint
-- The legacy schema omitted Auth.js' composite verification-token key. OAuth
-- does not use this table, but enforce equivalent uniqueness before email auth.
CREATE UNIQUE INDEX IF NOT EXISTS `verification_tokens_identifier_token_uq`
	ON `verification_tokens` (`identifier`,`token`);
--> statement-breakpoint
-- Auth.js normalizes OAuth emails before adapter lookup. Normalize legacy rows
-- too so casing cannot split one person across two local users.
UPDATE `users` SET `email` = LOWER(TRIM(`email`)) WHERE `email` IS NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS `users_normalized_email_migration_guard_uq`;
