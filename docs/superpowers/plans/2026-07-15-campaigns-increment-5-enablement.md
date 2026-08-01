# Campaigns Increment 5: Production Enablement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the release candidate on staging D1 under realistic concurrency, install production abuse controls and observability, rehearse rollback/recovery, and enable campaigns publicly without weakening the server feature boundary.

**Architecture:** The application retains the server-only feature gate and cursor polling design. A Cloudflare edge rate-limit adapter, behind a provider-neutral port, protects campaign mutations and high-frequency reads in production while the existing in-memory limiter remains development defense. Staging exercises the production Cloudflare adapter/D1 combination before a configuration-only public enablement.

**Tech Stack:** Cloudflare Workers Paid (per D4), Workers Static Assets, D1, Wrangler, SvelteKit Cloudflare adapter, Playwright, Vitest, Node load harness, deployment runbooks.

## Amendments — read before starting

**The Pages/Workers blocker is resolved: roadmap decision D4 (2026-07-27) migrates this project to Workers.** The plan's Workers assumptions are now correct rather than aspirational, but the migration is a *prerequisite* to this plan, not part of it, and two Workers facts change what Task 1 may promise. Read amendments 1–3 before starting Task 1.

1. **The Workers migration must land before Task 1, and it is not scoped here.** `wrangler.toml:3` is still a Pages config (`pages_build_output_dir = ".svelte-kit/cloudflare"`), so today `wrangler deploy --dry-run` emits `▲ WARNING It seems that you have run 'wrangler deploy' on a Pages project`, then `✘ ERROR Missing entry-point to Worker script`, and exits nonzero — failing Task 1 Step 6 and Task 6 Step 2 on first run, and making Task 1 Step 4's stated acceptance source unusable. The migration replaces `pages_build_output_dir` with `main = ".svelte-kit/cloudflare/_worker.js"`, an `[assets]` block (`binding = "ASSETS"`, `directory = ".svelte-kit/cloudflare"`), and `compatibility_flags = ["nodejs_als"]`; `[[d1_databases]]` is unchanged. No adapter change is required — `@sveltejs/adapter-cloudflare` 7.2.9 already targets both. It also swaps the Pages Git connection for Workers Builds (set `preview_urls = true` to retain per-branch previews), re-enters the environment variables and secrets listed in `DEPLOY.md`, and moves the `guildbook.arrowed.games` custom domain. Do not begin Task 1 until `npx wrangler deploy --dry-run` exits 0 on `main`.

   One behavioral difference to verify during the migration rather than assume: **Workers serves static assets before invoking the Worker**, where Pages ran functions first. Confirm no auth-gated or feature-gated route depends on function-first ordering; `run_worker_first` exists if one does.

2. **The rate-limit binding is per-Cloudflare-location, not global — correct the Global Constraint before implementing.** Cloudflare's documentation is explicit that limits "are local to the Cloudflare location that your Worker runs in", so each key gets a separate counter per colo. This plan's Global Constraint says production rate limiting "must be shared/edge-enforced", which a reader will take to mean one authoritative counter. It does not. The binding is a large improvement on `hooks.server.ts`'s per-isolate `Map` — it is durable across isolate churn and stops a single abusive or runaway client — but a client distributed across many locations obtains roughly N× the intended limit.

   Do not silently accept this and do not over-build for it. Task 1's `SharedRateLimiter` port already makes the implementation swappable; ship the Cloudflare binding as the v1 adapter and record in `campaign-capacity.md` the **written trigger** — a measured traffic or abuse threshold — at which a Durable Object-backed globally consistent adapter becomes justified. D4 chose Workers partly to keep that upgrade reachable at all; Pages cannot define a Durable Object.

3. **Only 10-second and 60-second periods are supported.** The binding's `[ratelimits.simple]` accepts any positive integer `limit` but restricts `period` to exactly 10 or 60 seconds. All four policies in Task 1 Step 1 (`session-command`, `campaign-mutation`, `join-attempt`, `session-poll`) fit within that, but `campaign.ts` must not expose an arbitrary-window API the provider cannot honor. The binding also requires Wrangler ≥ 4.36.0; this repository is on 4.106.0.

4. **The in-memory limiter claim is accurate but narrower than stated.** Specification §11's "existing per-isolate in-memory limiter" is real — `src/hooks.server.ts:26` (`writeBuckets` Map), `:25` (60 writes/60 s), `:66` (`isRateLimited()`) — and characterizing it as development-only defense is fair. But `:67` scopes it to `/api/` paths with mutating methods, so **polling GETs are entirely unlimited today**. This plan's `session-poll` policy therefore has no existing behavior to degrade to if the shared limiter is absent. Account for that in the fail-closed design.

5. **`tarot-art:verify` cannot run in the clean release suite.** Task 6 Step 2 includes it, but it rebuilds from the gitignored `assets-src/`. Use the `tarot-art:verify:ci` variant added by the art plan's amendment 2.

## Global Constraints

- Increment 4, the tarot artwork pipeline, and the D4 Workers migration must all be complete. `npx wrangler deploy --dry-run` exiting 0 on `main` is the gate for the third.
- Public enablement is configuration, not removal of the feature gate. `CAMPAIGNS_ENABLED=false` must remain a tested immediate rollback.
- Workers Paid is required unless the measured staging load test proves a documented alternative with at least 30% capacity headroom.
- Production rate limiting must be enforced at the edge and durable across isolate churn. The process-local `Map` in `src/hooks.server.ts` is not a production control. Note the limit is **per Cloudflare location, not global** (amendment 2) — do not describe it as a single shared counter in code comments, the runbooks, or the completion record.
- Do not log command bodies, private projections, card IDs from hidden zones, invite tokens, HMAC claims, raw character JSON, or session server/private state.
- D1 contention and sequential-per-database behavior must be measured with the selected polling cadence and nine concurrent campaign scenario.
- Do not add Durable Objects, WebSockets, or a full VTT as a release shortcut. If polling misses the gate, stop rollout and redesign explicitly.

---

### Task 1: Add a shared campaign rate-limit port and Cloudflare adapter

**Files:**
- Create: `src/lib/server/rate-limit/types.ts`
- Create: `src/lib/server/rate-limit/campaign.ts`
- Create: `src/lib/server/rate-limit/memory.ts`
- Create: `src/lib/server/rate-limit/cloudflare.ts`
- Modify: `src/hooks.server.ts`
- Modify: `src/app.d.ts`
- Modify: `wrangler.toml`
- Modify: `.env.example`
- Test: `tests/unit/campaign-rate-limit.test.ts`
- Test: `tests/integration/campaign-rate-limit.test.ts`

- [x] **Step 1: Write failing policy tests**

Test independent buckets for command mutations, lifecycle mutations, join attempts, and polling; key by authenticated user plus campaign where available, fall back to client address for invalid/unauthenticated join attempts. Verify unrelated campaigns/users do not share a bucket and `Retry-After` is returned without leaking resource existence.

```ts
export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface SharedRateLimiter {
  check(input: {
    key: string;
    policy: 'session-command' | 'campaign-mutation' | 'join-attempt' | 'session-poll';
  }): Promise<RateLimitDecision>;
}
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/unit/campaign-rate-limit.test.ts tests/integration/campaign-rate-limit.test.ts`

Expected: FAIL because the shared port does not exist.

- [x] **Step 3: Implement provider-neutral policy selection**

`campaign.ts` derives a hashed bucket key from actor/campaign/IP facts and calls the injected port. Raw IDs and addresses do not go into provider analytics. The memory implementation is deterministic/injectable-clock and used only for local/test. Campaign endpoints call the service after authentication when possible but before expensive state reconstruction.

- [x] **Step 4: Implement the Cloudflare binding adapter**

Add a dedicated rate-limit binding to `wrangler.toml` following the currently installed Wrangler schema, generate platform types with `npx wrangler types`, and expose the exact generated binding type in `App.Platform.env`. The adapter calls the binding's limit method, maps success/failure to `RateLimitDecision`, and fails closed for mutations but permits one degraded read/poll with a warning counter if the provider is temporarily unavailable.

Do not guess the binding API: the generated type file and `wrangler deploy --dry-run` are the acceptance source. Keep generated environment types committed only if that is already the repository convention; otherwise copy the minimal generated interface into `app.d.ts` with a source comment.

- [x] **Step 5: Restrict the old hook limiter**

Keep the `Map` limiter only when no production binding is present. In production with campaigns enabled, startup/first request must fail closed for campaign mutations if the shared binding is missing. Existing noncampaign API behavior may retain its current local limiter.

- [x] **Step 6: Run and commit**

Run:

```bash
npm test -- tests/unit/campaign-rate-limit.test.ts tests/integration/campaign-rate-limit.test.ts
npm run check
npx wrangler deploy --dry-run
```

Expected: every command exits 0 and Wrangler validates the binding.

```bash
git add src/lib/server/rate-limit src/hooks.server.ts src/app.d.ts wrangler.toml .env.example tests/unit/campaign-rate-limit.test.ts tests/integration/campaign-rate-limit.test.ts
git commit -m "feat(campaigns): enforce shared production rate limits"
```

### Task 2: Add privacy-safe operational metrics and health checks

**Files:**
- Create: `src/lib/server/observability/campaign-metrics.ts`
- Modify: `src/lib/server/session/command-service.ts`
- Modify: `src/lib/server/session/latest-cursor.ts`
- Modify: `src/lib/server/session/lifecycle.ts`
- Create: `src/routes/api/internal/campaign-health/+server.ts`
- Test: `tests/unit/campaign-metrics.test.ts`
- Test: `tests/integration/campaign-health.test.ts`

- [x] **Step 1: Write failing redaction tests**

Feed metrics/error helpers objects containing invite/card/character canaries and assert serialized sink calls include only names, counts, durations, status/rejection codes, retries, and coarse role/procedure labels.

- [x] **Step 2: Define a fixed metric allowlist**

```ts
export interface CampaignMetricPoint {
  name:
    | 'command_duration_ms'
    | 'command_retry_count'
    | 'command_rejection'
    | 'poll_duration_ms'
    | 'poll_no_change'
    | 'session_frozen'
    | 'session_recovered';
  value: number;
  tags: {
    commandType?: string;
    procedureKind?: string;
    actorRole?: 'gm' | 'player';
    outcome?: string;
  };
}
```

No generic `Record<string, unknown>` logging interface is permitted. Sanitize command type against a known enum; never pass IDs or request/response bodies.

- [x] **Step 3: Add an authenticated internal health endpoint**

Use a dedicated deployment secret and constant-time comparison. Report feature flag, D1 reachability, current content/runtime digest, migration presence, rate-limit binding presence, counts of active/frozen sessions, and oldest frozen age. Return aggregate data only. Disable entirely when the internal secret is absent.

- [x] **Step 4: Run and commit**

Run: `npm test -- tests/unit/campaign-metrics.test.ts tests/integration/campaign-health.test.ts`

Expected: PASS with all canaries absent.

```bash
git add src/lib/server/observability/campaign-metrics.ts src/lib/server/session/command-service.ts src/lib/server/session/latest-cursor.ts src/lib/server/session/lifecycle.ts src/routes/api/internal/campaign-health tests/unit/campaign-metrics.test.ts tests/integration/campaign-health.test.ts
git commit -m "feat(campaigns): add privacy-safe operations signals"
```

### Task 3: Validate migrations and contention on remote staging D1

**Files:**
- Create: `scripts/campaigns/staging-d1-smoke.mjs`
- Create: `docs/operations/campaign-staging.md`

- [x] **Step 1: Create a non-destructive staging smoke harness**

The script requires explicit `CAMPAIGN_STAGING_BASE_URL` and fixture credentials. It creates uniquely prefixed test users/campaigns through supported APIs, then verifies:

- campaign creation/join/attachment constraints;
- signed invite close/rotate behavior;
- simultaneous character attachment has exactly one winner;
- simultaneous session version claim has one N+1 winner and valid retry to N+2;
- structural stale command returns `409`;
- duplicate command ID idempotency;
- atomic failure path leaves no public partial effect;
- session survives a deployment between start and continuation using pinned runtime;
- end purges private/server secrets and retains public history.

It archives its fixture campaign at the end only after ending its session; it never deletes arbitrary rows.

- [x] **Step 2: Apply migrations to a dedicated staging database**

Run:

**Corrected 2026-07-27 — the commands below replace the plan's original ones.** The original named `npm run db:migrate:d1:remote` (which points at *production* `guild-book-db` and takes no environment flag) and `wrangler pages deploy`, which no longer applies now that D4's Workers migration has landed.

```bash
npm run db:migrate:d1:staging            # guild-book-staging-db, --env staging
ADAPTER=cloudflare npm run build
npx wrangler deploy --env staging
CAMPAIGN_STAGING_BASE_URL=https://guild-book-staging.esoneill.workers.dev \
CAMPAIGN_STAGING_AUTH_SECRET=<staging AUTH_SECRET> \
node scripts/campaigns/staging-d1-smoke.mjs
```

Expected: migrations apply once, deployment succeeds, smoke script exits 0. Confirm the Wrangler environment points to staging—not production—before the migration command; `npx wrangler deploy --dry-run --env staging` prints the resolved `env.DB` and is the cheapest way to check. The environment-qualified commands are documented in `docs/operations/campaign-staging.md`.

- [x] **Step 3: Record constraint evidence**

The runbook includes migration IDs, staging database ID, deployment commit, smoke fixture prefix, each contention result, and cleanup/archive outcome. Do not include invite URLs/tokens, session secrets, user auth tokens, or card identities.

- [x] **Step 4: Commit staging tools**

```bash
git add scripts/campaigns/staging-d1-smoke.mjs docs/operations/campaign-staging.md
git commit -m "test(campaigns): validate remote D1 session behavior"
```

### Task 4: Run realistic capacity and latency gates

**Files:**
- Modify: `tests/load/session-polling.mjs`
- Create: `tests/load/session-contention.mjs`
- Create: `docs/operations/campaign-capacity.md`

- [ ] **Step 1: Extend the harness to staging**

Run nine simultaneous campaigns with at least GM plus two players each for 30 minutes. Keep all table pages visible for the steady-state window, then test background/foreground and reconnect waves. Inject a realistic mix of no-change polls, independent draws, structural advances, private transfers, and session ends.

Capture only aggregate:

- total/peak requests per second;
- D1 rows read/written per operation class;
- p50/p95/p99 response latency;
- accepted-command-to-visible latency;
- `204` no-change ratio;
- version retry/conflict counts;
- rate-limit false positives;
- D1/Worker error rates.

- [ ] **Step 2: Enforce numeric pass criteria**

The scripts exit nonzero unless:

- 100% of accepted changes visible within 2 seconds to all visible authorized clients;
- HTTP/application error rate below 0.1%;
- no privacy canary leak;
- no lost/duplicated accepted command;
- projected monthly request/read/write consumption has at least 30% headroom against the selected paid limits/budget;
- p95 command and poll latency remains below the documented product threshold selected before the run.

Record the actual selected p95 threshold and rationale in `campaign-capacity.md` before running, so it cannot be moved after results are known.

- [ ] **Step 3: Run capacity and contention tests**

Run:

```bash
CAMPAIGN_LOAD_TARGET=staging node tests/load/session-polling.mjs
CAMPAIGN_LOAD_TARGET=staging node tests/load/session-contention.mjs
```

Expected: both exit 0. If either gate fails, keep the feature allowlisted and file an explicit architecture decision before changing polling cadence or adopting another coordination primitive.

- [ ] **Step 4: Commit evidence template and harness**

```bash
git add tests/load/session-polling.mjs tests/load/session-contention.mjs docs/operations/campaign-capacity.md
git commit -m "test(campaigns): prove staging capacity and latency"
```

Do not commit secrets or raw load logs containing identifiers; commit the sanitized aggregate report.

### Task 5: Rehearse freeze/recovery and feature rollback

**Files:**
- Create: `tests/e2e/campaign-recovery.spec.ts`
- Create: `docs/operations/campaign-rollback.md`
- Modify: `docs/operations/campaign-pilot.md`

- [x] **Step 1: Automate recovery scenarios**

Test corrupt fragment/version mismatch detection, automatic freeze, GM recovery after valid fragment repair/reload, GM sanitized end when recovery cannot proceed, overnight active session across deployment, and campaign archive blocked while frozen.

- [x] **Step 2: Rehearse configuration rollback on staging**

1. Start an active staging session and record its safe aggregate health.
2. Deploy `CAMPAIGNS_ENABLED=false` and empty pilot allowlist.
3. Verify campaign/join/API routes return `404`; character, rules, denizens, deck, login, and sharing still work.
4. Restore only operator pilot access, recover/end the session, verify public history.
5. Re-enable staging and verify no data migration rollback was required.

- [x] **Step 3: Document the forward-only rollback**

The runbook states who can flip flags, expected propagation time measured in rehearsal, how to identify/freeze affected sessions using aggregate IDs in secure operator tooling, privacy-safe evidence collection, and escalation. It explicitly forbids dropping tables or deleting journals/secrets as rollback.

- [x] **Step 4: Run and commit**

Run: `npx playwright test tests/e2e/campaign-recovery.spec.ts`

Expected: PASS.

```bash
git add tests/e2e/campaign-recovery.spec.ts docs/operations/campaign-rollback.md docs/operations/campaign-pilot.md
git commit -m "docs(campaigns): rehearse recovery and rollback"
```

### Task 6: Perform final release verification and enable publicly

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md`
- Modify: production environment configuration outside the repository

- [ ] **Step 1: Update product and operations documentation**

Add Keep a Changelog entries for campaigns, one-adventurer tenure/death behavior, shared tarot privacy, in-session procedures, RWS artwork, and known non-goals. README describes campaign creation/join/table flow and states this is not a VTT.

- [ ] **Step 2: Run the clean release suite**

From a clean install/worktree with source Markdown/art available for verification:

```bash
npm ci
npm run content:verify
npm run tarot-art:verify
npm run check
npm test
npx playwright test
ADAPTER=cloudflare npm run build
npx wrangler deploy --dry-run
git status --short
```

Expected: all commands exit 0; status contains only the intentional documentation changes; no ignored source art/Markdown is staged.

- [ ] **Step 3: Run the final privacy scan**

Run every role canary suite and scan built client/server artifacts for the unique secret canary strings:

```bash
npx playwright test tests/e2e/shared-table-privacy.spec.ts tests/e2e/challenge-privacy.spec.ts tests/e2e/session-history.spec.ts
rg -n "SECRET_PLAYER_|SERVER_ORDER_CANARY|INVITE_TOKEN_CANARY" .svelte-kit build
```

Expected: tests pass and `rg` returns no matches. If the adapter output uses `.svelte-kit/cloudflare` rather than `build`, scan that directory explicitly.

- [ ] **Step 4: Commit the release documentation**

```bash
git add CHANGELOG.md README.md
git commit -m "docs(campaigns): prepare public shared tarot release"
```

- [ ] **Step 5: Enable with rollback ready**

Deploy the verified commit with Workers Paid and shared rate-limit binding. Set `CAMPAIGNS_ENABLED=true` in production configuration while retaining the pilot list for operator recovery. Verify health, create/join/start/draw/end one production smoke campaign with dedicated test accounts, then archive it. Monitor command errors, retries, latency, no-change rate, and frozen sessions for the agreed release window.

Expected: public signed-in users see Campaigns navigation; unauthorized/disabled-style lookup behavior remains `404`; smoke session completes with no privacy leak or partial command.

## Increment 5 Completion Record

Record the release commit, migration/deployment identifiers, rate-limit binding validation, staging and production smoke results, capacity report, rollback rehearsal timing, full verification output, monitoring window, and final feature-flag state. Do not record raw tokens, hidden card identities, or private session payloads.
