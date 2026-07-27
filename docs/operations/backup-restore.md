# Backup and Restore Procedure — Guild Book

This runbook documents the pre-beta backup and the disaster-recovery procedure for Guild Book's production D1 database. **Every backup is useless until it has been tested** — this document records the steps to perform a rehearsed restore drill and verify its result.

## Pre-Beta Snapshot

**Status: NOT YET PERFORMED.** The owner must run the following before the beta opens. Nothing in this section has been executed or verified.

Export a point-in-time SQL dump from the production database and store it as an offline backup:

```bash
mkdir -p .backups
npx wrangler d1 export guild-book-db --remote --output .backups/guild-book-prebeta.sql
```

The resulting dump will contain the schema and data for `users`, `characters`, and `denizens` tables. **Before proceeding, verify that `.backups/` is ignored by git:**

```bash
git check-ignore .backups/guild-book-prebeta.sql
```

If that command prints nothing, add `.backups/` to `.gitignore` and commit that change — the dump contains real user emails and must never be committed to version control.

## Time Travel Coverage

Guild Book's D1 database benefits from Cloudflare's Time Travel feature, which allows restoration to any point within a rolling restore window.

- **Restore window:** `_____` (owner to fill in — run `npx wrangler d1 time-travel info guild-book-db` and record the reported window, e.g. "7 days")
- **Current bookmark / latest restorable point:** `_____` (owner to fill in — run `npx wrangler d1 time-travel info guild-book-db` and record the latest bookmark if present)

If the Time Travel command reports no bookmark, note that in the incident log: Time Travel coverage exists but no restore point has been recorded yet on this database.

## Restore Procedure

**⚠️ WARNING: This procedure destructively overwrites the production database. Do not run it except during a genuine data-loss incident.**

To restore the production database `guild-book-db` to a specific point in time, use the `--bookmark` flag with the exact bookmark value from the Time Travel info command above:

```bash
npx wrangler d1 time-travel restore guild-book-db --bookmark=<BOOKMARK>
```

Replace `<BOOKMARK>` with the exact bookmark value (e.g. `2026-07-27T15:30:00Z`). Cloudflare will confirm the bookmark is within the restorable window before executing.

Alternatively, you can restore to a specific timestamp using the `--timestamp` flag:

```bash
npx wrangler d1 time-travel restore guild-book-db --timestamp=<TIMESTAMP>
```

**Restoration is atomic:** the command succeeds entirely or rolls back entirely. Partial restores are not possible.

## Restore Drill

**Status: NOT YET PERFORMED.** The owner must run the following before the beta opens to verify backup integrity and procedure correctness. Nothing in this section has been executed or verified.

Create a throwaway database, load the backup snapshot into it, and verify the data:

```bash
npx wrangler d1 create guild-book-restore-drill
npx wrangler d1 execute guild-book-restore-drill --remote --file=.backups/guild-book-prebeta.sql
npx wrangler d1 execute guild-book-restore-drill --remote --command="SELECT count(*) FROM users;"
```

Record the user count from the last command. Then compare it to the production user count:

1. Visit `/admin` in the production app and record the total user count.
2. The counts must match to confirm the snapshot is complete and correct.

Then delete the drill database:

```bash
npx wrangler d1 delete guild-book-restore-drill
```

**Document the drill results:**

- **Scratch database name used:** `guild-book-restore-drill`
- **SQL dump restored:** `.backups/guild-book-prebeta.sql`
- **User count after restore:** `_____` (owner to fill in — run the SELECT count query above)
- **Production user count at backup time:** `_____` (owner to fill in — visit `/admin` before the restore drill and record it)

The counts must match. If they do not, the backup is incomplete or corrupted and must not be relied upon for recovery.

## Important: Activity Tracking Cannot Be Backfilled

The `first_seen_at`, `last_seen_at`, and `login_count` columns were added to the `users` table by migration `0009_user_activity.sql`. **These columns did not exist in any backup or snapshot created before this migration was applied.**

If a restore from a pre-migration backup is necessary:
- All user activity columns will be `NULL` or their default values after restore.
- No historical activity data can be reconstructed retroactively.
- The migration must be re-applied to the restored database after recovery.

This is an intentional design trade-off: activity tracking enables the `/admin` oversight page, but requires the migration to have already run in production before any user sign-ins are recorded.

## Incident Response Checklist

1. **Confirm the scope of data loss:** connect to `/admin`, compare the current user/character/denizen counts to known-good values from your monitoring or backups. Establish a specific recovery target (point-in-time).
2. **Verify the restore window:** run `npx wrangler d1 time-travel info guild-book-db` and confirm the target bookmark is within the reported window.
3. **Execute the restore:** run the restore command above with the confirmed bookmark.
4. **Verify post-restore:** connect to `/admin` and confirm user/character/denizen counts match expectations. Test sign-in and basic operations.
5. **Communicate:** update beta testers and stakeholders once the restore is confirmed.
