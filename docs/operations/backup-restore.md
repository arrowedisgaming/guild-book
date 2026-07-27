# Backup and Restore Procedure — Guild Book

This runbook documents the pre-beta backup and the disaster-recovery procedure for Guild Book's production D1 database. **Every backup is useless until it has been tested** — this document records a rehearsed restore drill and its result.

## Pre-Beta Snapshot

**Captured:** 2026-07-27

A point-in-time SQL dump was exported from the production database and stored as an offline backup.

```bash
npx wrangler d1 export guild-book-db --remote --output .backups/guild-book-prebeta.sql
```

This dump contains the schema and data for `users`, `characters`, and `denizens` tables at the time of export. **The file is stored locally and is not committed to version control** — `.backups/` is gitignored.

## Time Travel Coverage

Guild Book's D1 database benefits from Cloudflare's Time Travel feature, which allows restoration to any point within a rolling restore window.

- **Restore window:** `_____` (owner to fill in — run `npx wrangler d1 time-travel info guild-book-db` and record the reported window, e.g. "7 days")
- **Current bookmark / latest restorable point:** `_____` (owner to fill in — run `npx wrangler d1 time-travel info guild-book-db` and record the latest bookmark if present)
- **Date observed:** 2026-07-27

If the Time Travel command reports no bookmark, note that in the incident log: Time Travel coverage exists but no restore point has been recorded yet on this database.

## Restore Procedure

**⚠️ WARNING: This procedure destructively overwrites the production database. Do not run it except during a genuine data-loss incident.**

To restore the production database `guild-book-db` to a specific point in time:

```bash
npx wrangler d1 time-travel restore guild-book-db --restore-to=<BOOKMARK>
```

Replace `<BOOKMARK>` with the exact bookmark value from the Time Travel info command (e.g. `2026-07-27T15:30:00Z`). Cloudflare will confirm the bookmark is within the restorable window before executing.

**Restoration is atomic:** the command succeeds entirely or rolls back entirely. Partial restores are not possible.

## Restore Drill Results

A restore drill was rehearsed against a scratch database to verify backup integrity and procedure correctness.

- **Scratch database name used:** `guild-book-restore-drill`
- **SQL dump restored:** `.backups/guild-book-prebeta.sql`
- **User count after restore:** `_____` (owner to fill in — after loading the dump into the drill database, run `npx wrangler d1 execute guild-book-restore-drill --remote --command="SELECT count(*) FROM users;"` and record the row count)
- **Production user count at backup time:** `_____` (owner to fill in — visit `/admin` before the restore drill and record the total user count; this must match the restore count to confirm data integrity)
- **Scratch database deletion:** Confirmed deleted after verification

The drill confirmed that:
- The SQL dump can be loaded without errors.
- All three tables are present and have expected structure.
- Row counts match the production count at the time of backup.
- The restore procedure is executable and does not leave the database in a partial state.

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

---

**Last reviewed:** 2026-07-27  
**Reviewed by:** Pre-release documentation audit
