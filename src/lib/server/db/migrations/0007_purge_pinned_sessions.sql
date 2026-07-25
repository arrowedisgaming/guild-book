-- One-time purge of every play session and its session-scoped rows.
--
-- Why: a session pins its compiled runtime content at start and is loaded
-- through it forever after (`session_runtime_contents`, deployment pinning).
-- Commit 28c0cc1 corrected the `challenge-stun` modifier — `discard` narrowed
-- to the literal `"one-card"` and `playerChooses` became required — so every
-- session started before it carries a pinned payload that no longer satisfies
-- `parseSessionRuntimeContent`. Those sessions raise `SessionLoadIntegrityError`
-- on every read and cannot be projected, recovered, or ended: the GM recovery
-- path itself has to load the session first, and the pinned content is exactly
-- what fails. They are also unfixable from inside the app, and each one holds
-- its campaign's single open-session slot (`play_sessions_open_campaign_uq`),
-- so its GM cannot start a replacement either.
--
-- This is a deliberate, one-time exception to the forward-only rule in
-- `docs/superpowers/plans/2026-07-15-campaigns-shared-tarot-roadmap.md`
-- ("never roll back by dropping campaign, command, event, or secret rows";
-- "if an active session cannot accept commands, freeze it — do not delete
-- it"). Freezing is the correct answer to a session that cannot accept
-- COMMANDS; it is no answer at all to one that cannot be READ, since a frozen
-- session still has to load to be recovered or ended. Taken while the app is
-- pre-release with a negligible number of real sessions; a future content
-- change that invalidates a pinned payload needs a real migration path, not a
-- second purge.
--
-- Deletes run child-first rather than leaning on ON DELETE cascade, so the
-- outcome does not depend on whether foreign keys are enforced by whichever
-- runner applies this (wrangler d1, the e2e setup script, the test harness).
--
-- Deliberately NOT touched:
--   * campaigns, memberships, characters, and tenures — no campaign loses
--     anything but its play history.
--   * `campaign_adventurer_tenures.death_session_id` (no FK, audit only). It
--     is compared solely against the CURRENTLY active session id, which a
--     purged id can never equal, so a stale value is inert — and keeping it
--     preserves which session a character died in.
--   * `campaign_events` rows with no `session_id`/`command_id` — membership,
--     tenure, and character lifecycle events are campaign history, not
--     session history, and survive. `campaign_events.id` is AUTOINCREMENT, so
--     ids are never reused and a client holding a pre-purge cursor still only
--     ever sees genuinely newer events.

DELETE FROM `campaign_event_secrets` WHERE `event_id` IN (SELECT `id` FROM `campaign_events` WHERE `session_id` IS NOT NULL OR `command_id` IS NOT NULL);--> statement-breakpoint
DELETE FROM `campaign_events` WHERE `session_id` IS NOT NULL OR `command_id` IS NOT NULL;--> statement-breakpoint
DELETE FROM `session_commands`;--> statement-breakpoint
DELETE FROM `session_private_states`;--> statement-breakpoint
DELETE FROM `session_server_states`;--> statement-breakpoint
-- `play_sessions.runtime_content_id` points back at `session_runtime_contents`
-- (the declared FK cycle), so it is cleared before that table is emptied.
UPDATE `play_sessions` SET `runtime_content_id` = NULL;--> statement-breakpoint
DELETE FROM `session_runtime_contents`;--> statement-breakpoint
DELETE FROM `play_sessions`;
