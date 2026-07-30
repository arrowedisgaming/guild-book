# Campaign staging validation (Increment 5 Task 3)

Evidence that campaign and session constraints hold against **remote Cloudflare
D1**, not just SQLite. Unit and integration tests prove the logic; this proves
it survives the production driver, where batching, contention and
sequential-per-database behaviour actually differ.

> **Privacy rule for this document.** Record identifiers of infrastructure, not
> of people or play. Never paste an invite URL or token, a session server/private
> fragment, a user auth token, or a card identity. Counts, versions, statuses,
> rejection codes and fixture prefixes only.

## Environment under test

| Item | Value |
| --- | --- |
| Staging Worker | `guild-book-staging` |
| Staging URL | `https://guild-book-staging.esoneill.workers.dev` |
| Staging D1 database | `guild-book-staging-db` |
| Staging D1 database id | `684b27e8-8593-4020-a3f8-b2b022c25a2f` |
| Wrangler environment | `--env staging` |
| Source commit at time of run | `0665332` |
| Run date | 2026-07-27 |

The staging Worker and database share **nothing** with production but the source
tree. `env.DB` resolves to `guild-book-staging-db`; verify with
`npx wrangler deploy --dry-run --env staging` before any migration.

## Migrations

All ten applied cleanly and idempotently — a second run reports
`✅ No migrations to apply!`:

```
0000_dashing_surge            0005_campaign_lifecycle_claims
0001_auth_account_uniqueness  0006_shared_table_core
0002_auth_email_normalization 0007_purge_pinned_sessions
0003_campaign_character_versions  0008_saved_denizens
0004_campaign_foundation      0009_user_activity
```

```bash
npm run db:migrate:d1:staging     # guild-book-staging-db, --env staging
```

> **Never use `npm run db:migrate:d1:remote` for staging.** It names
> `guild-book-db` — production — and takes no environment flag. The staging
> script names its own database explicitly for exactly this reason.

## Running the harness

```bash
CAMPAIGN_STAGING_BASE_URL=https://guild-book-staging.esoneill.workers.dev \
CAMPAIGN_STAGING_AUTH_SECRET=<staging AUTH_SECRET> \
node scripts/campaigns/staging-d1-smoke.mjs
```

Add `CAMPAIGN_STAGING_DEPLOY_CHECK=1` to include the mid-session redeploy check
(slower — it actually redeploys the staging Worker).

The harness refuses to run without an explicit base URL and secret, refuses
non-HTTPS targets, and **refuses the production hostname** outright.

### How it authenticates, and why

Users are created by the Auth.js OAuth adapter, so there is no API to create
one. Rather than expose a login bypass on a public staging URL, the harness
seeds fixture users directly into staging D1 and signs its own Auth.js session
JWTs with the staging `AUTH_SECRET` (JWE, salted with the cookie name, carrying
`{ sub, sessionVersion: 2 }` to satisfy `auth-policy.ts`). Everything else —
campaigns, invites, joins, attachment, sessions, commands, ending — goes through
the real HTTP API.

Two fixture shortcuts are taken deliberately, and only to keep each check
focused on what remote D1 can break:

1. **Fixture users are seeded by SQL**, per the above.
2. **The fixture adventurer is finalized by SQL.** Attachment requires a
   non-draft adventurer, enforced in two independent places — the claim guard
   reads the `is_draft` column (`tenure.ts:135`) while the eligibility precheck
   reads `isDraft` inside the `data` JSON blob (`tenure.ts:532`). Both are set.
   Driving the full creation wizard through the API instead would test character
   validation, not the attachment race.

## Results — 2026-07-27, 11/11 passed

Fixture prefixes from the recorded runs: `smoke-ms3wqoxh`, `smoke-ms3wr4pz`.
Every row the harness creates carries its prefix.

| Constraint | Result |
| --- | --- |
| Fixture auth accepted | Session cookies accepted; authenticated campaign list `200` |
| Campaign create / invite / join | Campaign created; 2 players joined via signed invite |
| Unauthorized lookup hides existence | Nonmember campaign read → **`404`**, not `403` |
| Invite rotate | `POST` issued a **different** token |
| Invite close | Pre-close token no longer joins |
| Simultaneous character attachment | **Exactly one winner**; loser `409` |
| One open session per campaign | Second concurrent start refused (`400`) |
| Duplicate command id idempotency | Replay returned the **original** outcome at the same version — no second advance |
| Structural stale command | `409` with `stale-structure` |
| Simultaneous session version claim | Serialized. Run A: both committed at **versions 3 then 4** (retry landed on N+2). Run B: one committed at 3, the other rejected cleanly. Never the same resulting version twice. |
| Rejected command leaves no public effect | `illegal-command`; session version unchanged |
| Session survives a deployment | Staging redeployed mid-session; next command accepted, **version 3 → 4**, pinned runtime intact |
| Ending purges private state | No `shuffleSeed` / `serverFragment` / `privatePayload` / `secretPayload` keys in the ended-session projection |
| Ending retains public history | Public history retains the session; `publicHistoryChecksum` present; no open session remains |

### Both version-claim outcomes are correct

The two runs differ because the race is genuinely non-deterministic, and the
harness asserts the invariant rather than one outcome: **no two accepted
commands may claim the same resulting version.** Either the loser retries onto
N+2 (run A) or it is rejected cleanly (run B). A failure would be two accepted
commands reporting the same version, or an accepted command vanishing.

### Not externally inducible

**Atomic batch-failure injection.** No public endpoint can force a D1 batch to
fail mid-write, so the harness asserts the observable half — a rejected command
must not advance the session version or emit a public event. Full partial-write
coverage lives in `tests/integration/session-atomicity.test.ts` against both
SQLite and D1 batch paths. This is stated rather than quietly skipped.

## Cleanup

The harness archives its own fixture campaign after ending its session
(`archive returned 200`) and **never deletes arbitrary rows**. Fixture users,
characters and campaign rows are retained under their prefix for inspection.

To clear accumulated fixtures from staging — never production — filter on the
prefix:

```bash
npx wrangler d1 execute guild-book-staging-db --remote --env staging \
  --command "select id from campaigns where id like 'smoke-%' or name like 'smoke-%'"
```

Review before deleting anything. Staging fixtures are cheap; an accidental
`delete` pointed at the wrong database is not.

## Known gap at time of run

*(Superseded 2026-07-30: the binding does enforce — the self-test's margin was
too thin. See `DEPLOY.md`. The paragraph below is left as written at the time of
the run.)*

`rateLimit.enforcement` reported **`not-enforcing`** on staging and production
alike. The Cloudflare rate-limit binding deploys and resolves but does not
count; see `DEPLOY.md` and the migration plan's completion record. This does not
affect any constraint in the table above — every one of them is enforced by D1
and application logic, not by the limiter — but it **blocks Gate E**, and
therefore blocks making campaigns public.
