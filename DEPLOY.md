# Deploying Guild Book (Cloudflare Workers + D1)

Production target: **Cloudflare Workers** with Workers Static Assets, and **D1**
as the database. Migrated from Cloudflare Pages on 2026-07-27 (roadmap decision
D4 — see `docs/superpowers/plans/2026-07-27-cloudflare-workers-migration.md`).

Build: `ADAPTER=cloudflare npm run build` → output `.svelte-kit/cloudflare`,
which contains `_worker.js` **and** the static asset tree.
`@sveltejs/adapter-cloudflare` detects the target from `wrangler.toml`: with
`main` + `[assets]` present it emits an `.assetsignore` and no `_routes.json`.
The build command is identical to the old Pages one.

> **Production deploys are GitHub-gated.** Pushing `main` does not deploy.
> Production is published only by `.github/workflows/release.yml`, from an
> exact `vX.Y.Z` tag after the tagged commit passes the complete reusable CI
> workflow and the protected `production` environment is approved. Direct
> local deploys are reserved for emergency recovery.

---

## GitHub-gated production releases

### One-time GitHub and Cloudflare setup

1. In Cloudflare, create a dedicated API token from the **Edit Cloudflare
   Workers** template. Restrict its account resources to the account containing
   `guild-book` and its zone resources to `arrowed.games`; do not use a global
   API key or a personal all-resources token.
2. Copy the account ID from the Cloudflare dashboard. Keep both values out of
   local files, shell history, commits, issue comments, and workflow logs.
3. In GitHub, open **Settings → Environments → New environment** and create an
   environment named exactly `production`.
4. Add the repository owner as a required reviewer. Restrict deployment
   branches and tags so only tags matching `v*` may enter the environment.
5. Add these as **environment secrets**, not plaintext variables and not
   committed `.env` values:

   | Secret | Value |
   | --- | --- |
   | `CLOUDFLARE_API_TOKEN` | The restricted deployment token |
   | `CLOUDFLARE_ACCOUNT_ID` | The account containing the production Worker |

The workflow intentionally has read-only repository permissions. Cloudflare
credentials are available only to the protected deployment job; pull requests,
ordinary `main` builds, metadata validation, and browser tests cannot read them.

### Cut a release

1. Move the release notes out of `[Unreleased]`, add a dated
   `## [X.Y.Z] - YYYY-MM-DD` heading, and set `package.json` to the same version.
2. Run the complete credential-free release gate locally:

   ```bash
   git fetch origin main
   npm run release:verify
   ```

   This validates the current package/changelog metadata and compares content
   changes against the freshly fetched `origin/main` before running the rest of
   the credential-free gate.

3. Merge that exact commit to `main`. Apply any required production D1
   migrations and preflights before approving deployment; the workflow never
   applies remote migrations automatically.
4. Create and push the matching annotated tag:

   ```bash
   git tag -a vX.Y.Z -m "Release vX.Y.Z"
   git push origin vX.Y.Z
   ```

5. Open the **Release** workflow in GitHub Actions. Metadata validation and the
   reusable CI workflow must both succeed before the production approval prompt
   appears. Confirm migrations are complete, then approve the `production`
   environment.
6. After Wrangler reports the deployment, perform the smoke test in section 5
   against `https://guildbook.arrowed.games`.

If verification fails, do not move or recreate the tag. Fix the problem on a
new commit, update the version/changelog as appropriate, and cut a new tag. A
tagged build that passed only on Playwright retry remains failed by design.

---

## 1. One-time: create the D1 database

```bash
npx wrangler login                       # opens browser → authorize
npx wrangler d1 create guild-book-db     # prints a database_id
```

Paste the printed `database_id` into `wrangler.toml`'s `[[d1_databases]]` block.

Apply the schema to the remote database:

```bash
npm run db:migrate:d1:remote             # wrangler d1 migrations apply guild-book-db --remote
```

## 2. One-time: create the Worker

Either deploy from the CLI (what was actually done):

```bash
ADAPTER=cloudflare npm run build
npx wrangler deploy --env ''
```

Do not also connect Workers Builds to this repository. GitHub Actions owns the
production deployment path; enabling a second push-to-deploy system would
bypass its tag validation, required checks, and protected-environment approval.
Wrangler still reads `wrangler.toml`, which declares `main`, `[assets]`, D1, the
rate-limit bindings, and the custom domain.

### Secrets (`wrangler secret put <NAME>`)

Secrets are write-only: they cannot be read back, only replaced. Set each with
`npx wrangler secret put NAME`, or pipe a value in with
`printf '%s' "$VALUE" | npx wrangler secret put NAME`.

| Secret | Value |
| --- | --- |
| `AUTH_SECRET` | `openssl rand -base64 33`. Rotating it signs out every existing session — recommended at rollout (`src/lib/server/auth-policy.ts`). |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | from Google Cloud Console (step 3) |
| `AUTH_DISCORD_ID` / `AUTH_DISCORD_SECRET` | from Discord Developer Portal (step 3) |
| `CAMPAIGN_INVITE_SECRET` | dedicated random value; rotating invalidates outstanding invite links |
| `CAMPAIGN_HEALTH_SECRET` | dedicated random value; guards `/api/internal/campaign-health`, which 404s to everyone when unset |
| `ADMIN_EMAILS` | Comma-separated admin addresses. Unset or empty means nobody can reach `/admin`. |
| `FEEDBACK_URL` | Optional. Where the alpha banner's "Send feedback" link points. Omit to hide the link. |

`ADMIN_EMAILS` and `FEEDBACK_URL` are not secrets by nature, but are set as
secrets deliberately — see the `[vars]` warning below.

### Plaintext variables

Only `AUTH_URL` lives in `wrangler.toml`'s `[vars]`.

> **`[vars]` is replaced wholesale on every deploy.** A variable set in the
> dashboard but not listed in `wrangler.toml` silently disappears on the next
> `wrangler deploy`. Secrets are *not* affected — they survive deploys. Put
> anything you don't want in the repo in the secret store, not in dashboard
> vars.

`ADAPTER` is only a build-time switch, set in the build command. `NODE_VERSION`
is not needed (that was a Pages build-image setting). Do **not** set
`AUTH_DEV_LOGIN` / `AUTH_DEV_AUTOLOGIN` in production.

### Bindings

`wrangler.toml` declares them all; `npx wrangler deploy --env ''` prints the resolved
list on every deploy, and `npx wrangler deploy --dry-run --env ''` does the same without
shipping. Expect:

| Binding | Resource |
| --- | --- |
| `DB` | D1 `guild-book-db` |
| `ASSETS` | Workers Static Assets |
| `CAMPAIGN_SESSION_COMMAND_LIMITER` | Rate Limit, 300/60s |
| `CAMPAIGN_MUTATION_LIMITER` | Rate Limit, 60/60s |
| `CAMPAIGN_JOIN_LIMITER` | Rate Limit, 10/60s |
| `CAMPAIGN_POLL_LIMITER` | Rate Limit, 30/10s |
| `CAMPAIGN_LIMITER_SELFTEST` | Rate Limit, 1/10s — never limits a real request |

> **RESOLVED 2026-07-30 — the bindings do enforce; our probe was wrong.**
>
> From 2026-07-27 this section reported that the rate-limit bindings never
> counted, and that was treated as a release blocker for making campaigns
> public. The 0.7.0 pre-release review found the fault was in the self-test,
> not the provider: it called the limiter `limit + 1` times — **two** calls
> against a 1-per-10s binding — and Cloudflare documents these counters as
> permissive and eventually consistent rather than exact, so a working binding
> is allowed to let two through. Zero denials was read as "never counts".
>
> Widening the overshoot to `limit + 5` (`SELF_TEST_OVERSHOOT` in
> `src/lib/server/rate-limit/cloudflare.ts`) flipped staging to `"enforcing"`
> on **10 of 11 consecutive probes**, the single exception being the first
> probe against a freshly-created namespace whose counter had not yet
> materialised.
>
> `/api/internal/campaign-health` reports `rateLimit.enforcement`; anything
> other than `"enforcing"` is still a release blocker for making campaigns
> public. **Verify production separately** — the result above is staging, and
> production has its own namespaces and its own health secret.
>
> **One thing this does not explain.** The 2026-07-27 investigation recorded a
> bare throwaway Worker allowing 13 consecutive requests against a 5-per-60s
> limiter. That overshoot is far too wide for documented permissiveness, so it
> is not accounted for by the probe bug. Update the Cloudflare ticket with this
> finding rather than simply closing it.

## 3. One-time: OAuth apps

Auth.js callback paths are `/auth/callback/<provider>`.

**Google** — [console.cloud.google.com](https://console.cloud.google.com) →
APIs & Services → Credentials → Create OAuth client ID (Web application):
- Authorized redirect URI: `https://guildbook.arrowed.games/auth/callback/google`
- Configure the consent screen (external, app name "Guild Book", publish).

**Discord** — [discord.com/developers/applications](https://discord.com/developers/applications)
→ New Application → OAuth2:
- Redirect: `https://guildbook.arrowed.games/auth/callback/discord`
- Copy Client ID + Client Secret.

If a `*.pages.dev` or `*.workers.dev` callback was ever registered for testing,
remove it — `workers.dev` is disabled on this Worker.

## 4. One-time: custom domain

Declared in `wrangler.toml` and applied on deploy:

```toml
routes = [{ pattern = "guildbook.arrowed.games", custom_domain = true }]
```

Workers custom domains require Cloudflare-managed nameservers (Pages accepted a
plain CNAME). `arrowed.games` already resolves to `vita`/`decker.ns.cloudflare.com`,
so the DNS record is created automatically.

A hostname can only attach to **one** service at a time, so the deploy fails
with "already in use" until the domain is removed from any Pages project
holding it.

> `routes` **is inherited** by named environments. `[env.staging]` therefore
> sets `routes = []` explicitly — without it, `wrangler deploy --env staging`
> reassigns the production domain to the staging Worker, which has an empty
> database and no OAuth providers. Do not remove that line.

## 5. Smoke test

1. `https://guildbook.arrowed.games/` loads with the book typography.
2. Sign in with Google, then Discord.
3. Create an adventurer end-to-end and save; confirm it appears in
   **My Adventurers** (that's a D1 round-trip).
4. Open the sheet: toggle a condition (autosave), Take a Wound, download the
   PDF, mint a share link and open it in a private window.
5. `/licensing` shows the required notice.
6. `curl -H "Authorization: Bearer $CAMPAIGN_HEALTH_SECRET" \
   https://guildbook.arrowed.games/api/internal/campaign-health` returns 200
   with `database.reachable: true`; without the header it returns 404.

## Staging

A separate Worker and a separate D1 database — it shares nothing with
production but the source tree.

```bash
npm run db:migrate:d1:staging            # guild-book-staging-db, NOT production
ADAPTER=cloudflare npm run build
npx wrangler deploy --env staging        # → guild-book-staging.esoneill.workers.dev
```

`npm run db:migrate:d1:remote` names the **production** database and takes no
environment flag. Never use it for staging.

## Ongoing

- **Deploy** = push a validated `vX.Y.Z` tag and approve the protected
  `production` environment after its exact commit passes reusable CI. Pushing
  `main` alone deploys nothing. Use local `wrangler deploy` only during a
  documented emergency recovery when the GitHub release path is unavailable.
- **Schema changes**: `npm run db:generate` locally and commit the migration.
  Apply every required remote migration **before** deploying code that depends
  on it; CI does not migrate D1.
- **User activity tracking (migration `0009_user_activity.sql`) — this
  ordering is not optional**: run `npm run db:migrate:d1:remote` **before**
  deploying the activity-tracking code. The `jwt` callback in
  `src/lib/server/auth-policy.ts` reads `first_seen_at`, `last_seen_at`, and
  `login_count` on every authenticated request, and that read is deliberately
  not guarded by a try/catch. If the code deploys before the migration runs,
  every returning sign-in throws `no such column: users.first_seen_at` —
  every beta tester is 500'd or force-signed-out until the migration is
  applied. This is unlike migration `0008`, where code-before-migration was
  harmless.
- **Auth account-linking migrations**: run
  `npm run db:auth:preflight:d1:remote`, confirm both result sets are empty,
  then run `npm run db:migrate:d1:remote`. Do not deploy the adapter-backed auth
  code until every migration succeeds. Rotate `AUTH_SECRET` during the rollout
  to sign out legacy sessions.
- **Rollback**: `npx wrangler deployments list` then
  `npx wrangler rollback [version-id]`. Cloudflare dashboard → the Worker →
  **Deployments** shows the same versions. Until the Pages project is retired,
  the deeper fallback is to remove the custom domain from the Worker and
  re-attach it to the `guild-book` Pages project — its last successful
  deployment is still servable even though its Git builds now fail on the
  missing `pages_build_output_dir`.
- Logs: `npx wrangler tail` (add `--env staging` for staging).

## Backup and Restore

See `docs/operations/backup-restore.md` for the complete disaster-recovery procedure, including backup export, Time Travel coverage checks, and a restore drill to rehearse before any incident occurs.

Do not run the restore procedure except in response to a genuine production incident involving data loss.

## Pre-launch licence reminder

`static/fonts/LICENSES.md`: Goudy Old Style is a Monotype commercial face —
license it for web embedding or swap the `--font-sidebar` token to an OFL
substitute (e.g. Sorts Mill Goudy) before a genuinely public launch.
