# Cloudflare Pages → Workers Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move production from Cloudflare Pages to Cloudflare Workers Static Assets without changing application code, so that Increment 5's rate-limit binding, `wrangler types`, and `wrangler deploy --dry-run` become real, and so the Durable Object upgrade path stays reachable.

**Architecture:** The SvelteKit build is unchanged — `@sveltejs/adapter-cloudflare` already emits `_worker.js` alongside the static assets in `.svelte-kit/cloudflare`, which is exactly the shape Workers Static Assets consumes. The migration replaces `wrangler.toml`'s Pages declaration with a Workers one, swaps the Pages Git connection for Workers Builds, and moves the custom domain. D1 is untouched.

**Tech Stack:** Cloudflare Workers Static Assets, Workers Builds, D1, Wrangler 4.106.0, `@sveltejs/adapter-cloudflare` 7.2.9, SvelteKit 2.

## Why — roadmap decision D4 (Resolved 2026-07-27)

Full rationale lives in `2026-07-15-campaigns-shared-tarot-roadmap.md`'s Decision Log, row D4. Summary:

- **Not decided on deprecation.** Cloudflare directs new investment to Workers and the products converge over time, but existing Pages projects are committed to keep working. Tiebreaker only.
- **Decided on a capability gap.** The rate-limit binding is absent from the Pages Functions binding list. Every Pages alternative fails for its own reason: a D1 counter writes on every request including ~1s polls and spends the contention budget Increment 5 Task 4 must prove headroom against; KV is ~1 write/sec per key and eventually consistent; a Durable Object counter is correct but **Pages can bind to a DO and never define one**, so it needs a companion Worker anyway; a dashboard WAF rule works but lives outside version control, cannot be exercised by Task 1's tests, and needs a paid WAF tier to key on the signed-in user.
- **Decided on the ceiling.** The owner's framing was to assume large scale rather than design for the expected pilot audience. Workers keeps every limiter design reachable — binding now, DO-backed globally consistent counter later. Pages permanently forecloses the best one.

## Verified before writing this plan

Do not re-derive these; they were checked empirically on 2026-07-27.

| Fact | Evidence |
|---|---|
| Build output already suits Workers | `ADAPTER=cloudflare npm run build` emits `_worker.js` (4.3 kB) **and** the static asset tree into `.svelte-kit/cloudflare`. `main` and `assets.directory` both point there. **The build command does not change.** |
| No adapter swap needed | `@sveltejs/adapter-cloudflare` 7.2.9 targets both Workers Static Assets and Pages. Only `adapter-cloudflare-workers` is deprecated. |
| Custom domain prerequisite holds | `dig +short NS arrowed.games` → `vita.ns.cloudflare.com`, `decker.ns.cloudflare.com`. Workers custom domains require Cloudflare-managed nameservers (Pages allowed a plain CNAME); this is satisfied. |
| Assets-first is not a behavior risk for existing static paths | The generated `_routes.json` already excludes `/_app/immutable/*`, fonts, content-pack JSON, favicon and the brand image from the Pages function, so no route ever depended on function-first ordering for those. Workers' assets-first default is equivalent. Still verify the auth/feature-gated routes explicitly (Task 2 Step 3). |
| CI needs no change to keep working | `.github/workflows/ci.yml:28-30` only runs `npm run build` with `ADAPTER=cloudflare`; there is no Pages deploy step. |
| Rate-limit binding requires Wrangler ≥ 4.36.0 | Repository is on 4.106.0. Satisfied. |

## Global Constraints

- **This plan changes no application code.** If a task requires a `src/` edit beyond `app.d.ts` types, stop and record why — it means an assumption above was wrong.
- The Pages project stays alive and deployable until the Worker is verified on the live domain. Do not delete it in this plan.
- D1 is not migrated, recreated, or re-bound to a different database. Same `database_id`, same `[[d1_databases]]` block, same `db:migrate:d1:*` commands.
- `DEPLOY.md` is accurate for Pages today. Rewrite it **when the cutover lands**, not before — a half-migrated runbook is worse than an old one.
- Do not set `not_found_handling = "single-page-application"`. The generic Cloudflare migration guide suggests it, but this is an SSR app and unmatched requests must reach the Worker.
- No secret values in the repository, in commits, or in this plan. Names only.

---

### Task 1: Rewrite the Wrangler configuration for Workers

**Files:**
- Modify: `wrangler.toml`

- [x] **Step 1: Replace the Pages declaration**

Remove `pages_build_output_dir`. Add `main`, an `[assets]` block, and the compatibility flags. Keep `name`, `compatibility_date`, and the entire `[[d1_databases]]` block byte-identical.

```toml
name = "guild-book"
compatibility_date = "2026-07-01"
main = ".svelte-kit/cloudflare/_worker.js"

[assets]
binding = "ASSETS"
directory = ".svelte-kit/cloudflare"

[[d1_databases]]
binding = "DB"
database_name = "guild-book-db"
database_id = "3cab8443-35f9-4a1f-864d-49249ae80fc0"
migrations_dir = "src/lib/server/db/migrations"
```

- [x] **Step 2: Determine whether `nodejs_als` is actually required**

The adapter's documentation lists `compatibility_flags = ["nodejs_als"]` for the Workers target, but this repository currently runs on Pages with **no compatibility flags at all** and works. Do not cargo-cult the flag. Build, run `wrangler deploy --dry-run`, and add it only if the dry run or a preview deployment demonstrates a need (Auth.js / AsyncLocalStorage is the likely trigger). Record the finding in the completion record either way.

- [x] **Step 3: Verify the dry run**

Run:

```bash
ADAPTER=cloudflare npm run build
npx wrangler deploy --dry-run
```

Expected: both exit 0. This is the gate Increment 5 amendment 1 names — Increment 5 Task 1 may not begin until it passes on `main`.

- [x] **Step 4: Commit**

```bash
git add wrangler.toml
git commit -m "build(deploy): target Cloudflare Workers static assets"
```

### Task 2: Stand up the Worker alongside the live Pages project

No repository changes. The Pages project keeps serving production throughout this task.

- [ ] **Step 1: Create the Worker and its Git connection**

Cloudflare dashboard → Workers & Pages → Create → Worker → connect the `guild-book` repository via **Workers Builds**. Production branch `main`; build command `ADAPTER=cloudflare npm run build`. Set `preview_urls = true` to retain per-branch preview deployments equivalent to the Pages previews.

- [x] **Step 2: Re-enter environment variables and secrets**

Every variable listed in `DEPLOY.md` §2 must exist on the Worker: `AUTH_SECRET` (secret), `AUTH_URL`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_DISCORD_ID`, `AUTH_DISCORD_SECRET`, `NODE_VERSION`. Do **not** set `AUTH_DEV_LOGIN` / `AUTH_DEV_AUTOLOGIN`. Confirm the `DB` binding resolves to `guild-book-db` under the Worker's settings.

Note `AUTH_URL` still points at the production domain while the Worker is only reachable on `*.workers.dev`; OAuth sign-in on the workers.dev URL will not complete until Task 3. Test what can be tested without auth first.

- [x] **Step 3: Verify assets-first ordering against gated routes**

On the `*.workers.dev` URL, confirm the feature gate and auth guards still behave: `/campaigns` returns the same status for a signed-out visitor as it does on Pages, and no static path shadows a dynamic route. If any gated route is served as a static asset without invoking the Worker, set `run_worker_first` for that path and record it.

- [x] **Step 4: Smoke the Worker without the custom domain**

Public pages render with correct fonts and typography; `/licensing` shows the required notice; a content-pack JSON asset loads; the deck page renders tarot cards. Defer everything requiring OAuth to Task 3.

### Task 3: Cut the custom domain over

This is the one step with production-visible risk. Pick a low-traffic window.

- [x] **Step 1: Record rollback facts before touching DNS**

Note the current Pages deployment ID and confirm the Pages project still builds. The rollback is: remove the domain from the Worker, reattach it to the Pages project.

- [x] **Step 2: Move `guildbook.arrowed.games` to the Worker**

Remove the custom domain from the Pages project, then add it to the Worker. The zone is already Cloudflare-managed so the record is created automatically.

- [x] **Step 3: Full production smoke**

Run `DEPLOY.md` §5 end to end on the live domain: sign in with Google **and** Discord (this is the first real test of `AUTH_URL` and the callback paths), create an adventurer and save it (a D1 round-trip), open the sheet, toggle a condition, take a wound, download the PDF, mint a share link and open it in a private window.

- [x] **Step 4: Check the optional preview redirect**

If a `<project>.pages.dev` callback URL was ever registered in the Google or Discord OAuth apps, previews now live on `*.workers.dev` — update or remove it. This is optional and may never have been configured.

### Task 4: Update the runbook and add the dry-run gate

**Files:**
- Modify: `DEPLOY.md`
- Modify: `.github/workflows/ci.yml`
- Modify: `CHANGELOG.md`

- [x] **Step 1: Rewrite `DEPLOY.md` for Workers**

Retitle from "Cloudflare Pages + D1". Replace §2's Pages project creation with the Workers Builds connection, replace the rollback line (Pages Deployments → Rollback) with Workers versions/gradual deployments, and replace the log tail command (`wrangler pages deployment tail`) with the Workers equivalent. §1 (D1 creation), §3 (OAuth apps), §4 (custom domain, now Workers), §5 (smoke test) and the pre-launch font licence reminder carry over largely intact.

- [x] **Step 2: Add `wrangler deploy --dry-run` to CI**

Now that it is meaningful, add it as a build-validation step after `npm run build`. This is the standing guard that the Workers config stays valid — and it is the gate Increment 5 depends on.

- [x] **Step 3: Changelog and commit**

Keep a Changelog entry under Changed. Then:

```bash
git add DEPLOY.md .github/workflows/ci.yml CHANGELOG.md
git commit -m "docs(deploy): document the Workers deployment target"
```

- [ ] **Step 4: Retire the Pages project**

Only after the domain has served correctly for an agreed soak period. Delete the Pages project, or leave it disconnected from Git as a cold fallback. Record which was chosen.

## Migration Completion Record

**Completed 2026-07-27.** All four tasks done except Task 2 Step 1's Git connection and Task 4 Step 4's Pages retirement, both recorded below as deliberately outstanding.

| Item | Result |
|---|---|
| Worker name | `guild-book` |
| First production deployment | version `0b3499f4-b76e-4606-a172-0cb6bd25fce0` (workers.dev only, no domain) |
| Domain cutover deployment | version `a4709814-2b5e-4a30-a993-63e335222a94` |
| `nodejs_als` required? | **No.** `nodejs_compat` was already present and is mandatory for `node:crypto`; at `compatibility_date = 2026-07-01` it also supplies AsyncLocalStorage, making `nodejs_als` redundant. The plan's Task 1 Step 1 TOML snippet omitted `compatibility_flags` entirely — that would have re-broken `node:crypto` (the failure fixed by `7410901`), so the flag was kept. |
| Any route needing `run_worker_first`? | **No.** Static assets (favicon, content-pack JSON, fonts) return 200 while SSR routes were still 500ing pre-secrets, confirming assets-first serving works without shadowing dynamic routes. `/campaigns` continued to 404 via the server-side feature gate throughout. |
| Cutover timestamp | 2026-07-27, ~23:40 UTC |
| Observed downtime | Not precisely measured. Bounded by the interval between removing the domain from Pages and the Worker deploy completing — a single operator-paced step, under ~2 minutes. No "already in use" retry was needed. |
| OAuth smoke, both providers | **Passed.** Google and Discord sign-in, adventurer read and save (D1 round-trip), PDF export, and share link in a private window all confirmed by the owner on the live domain. |
| CI dry-run gate | Added for both production and `--env staging`. Verified to exit 0 with **no** Cloudflare credentials, so it needs no CI secrets. |
| Pages project disposition | **Retained, not deleted.** Left Git-connected but its builds now fail on the missing `pages_build_output_dir`; its last successful deployment remains servable, so the rollback (re-attach the domain to Pages) stays viable. Retire only after an agreed soak. |

### Findings worth carrying forward

1. **The rate-limit binding does not enforce — the capability D4 migrated for.** `limit()` returns `success: true` regardless of volume. Ruled out: configuration (both `[[ratelimits]]` and legacy `[[unsafe.bindings]]` forms), account plan (reproduced after upgrading to Workers Paid), application code (reproduced on a bare throwaway Worker: a 3-per-10s limiter on a fixed key allowed 9 consecutive requests), and Wrangler version (4.114.0 as well as 4.106.0). Open with Cloudflare support. **Increment 5 cannot pass Gate E until this is resolved**; the owner chose to cut over regardless, since campaigns remain gated off and nothing else is affected.

2. **`routes` IS inherited by named environments.** Wrangler warns that deploying `--env staging` would reassign `guildbook.arrowed.games` away from the production Worker onto staging — which has an empty database and no OAuth providers, i.e. a production outage from a routine staging deploy. `[env.staging]` now sets `routes = []` explicitly. Bindings (`[assets]`, `[[d1_databases]]`, `[[ratelimits]]`) are *not* inherited and must be redeclared per environment; `main`, `compatibility_date` and `compatibility_flags` are.

3. **Declaring `routes` silently disables `workers_dev` and `preview_urls`** unless each is set explicitly. Here that was desirable — it closed a public `workers.dev` front door onto the production database — but per-branch previews will need `preview_urls = true` when Workers Builds is connected.

4. **`[vars]` is replaced wholesale on every deploy; secrets are not.** Anything set in the dashboard but absent from `wrangler.toml` disappears on the next deploy. `ADMIN_EMAILS` and `FEEDBACK_URL` are therefore stored as secrets despite not being sensitive.

5. **Cloudflare secrets are write-only**, so the pre-migration `AUTH_SECRET` could not be copied from Pages to the Worker. Rotation was forced, which `auth-policy.ts:65` recommends at rollout anyway. Blast radius verified as 3 production users and zero DB session rows (strategy is `jwt`); share links resolve a stored `shareId`, not a signed token, so they survived.

### Outstanding

- **Workers Builds Git connection** (Task 2 Step 1) — dashboard-only GitHub OAuth flow, not wired. Deploys are manual `wrangler deploy`; pushing `main` ships nothing. `DEPLOY.md` says so at the top.
- **Pages project retirement** (Task 4 Step 4) — deliberately deferred while it is the rollback.
- `secrets.production.env` exists locally, gitignored, holding live OAuth credentials. Delete once no longer needed.
