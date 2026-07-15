# Campaigns Increment 5: Production Enablement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the release candidate on staging D1 under realistic concurrency, install production abuse controls and observability, rehearse rollback/recovery, and enable campaigns publicly without weakening the server feature boundary.

**Architecture:** The application retains the server-only feature gate and cursor polling design. A shared Cloudflare edge rate-limit adapter protects campaign mutations and high-frequency reads in production while the existing in-memory limiter remains development defense. Staging exercises the production Cloudflare adapter/D1 combination before a configuration-only public enablement.

**Tech Stack:** Cloudflare Pages/Workers Paid, D1, Wrangler, SvelteKit Cloudflare adapter, Playwright, Vitest, Node load harness, deployment runbooks.

## Amendments — read before starting

**Blocking decision: this project deploys to Pages, and two of this plan's mechanisms are Workers-only.** Resolve this before Task 1; it is a deployment-architecture decision, not an implementation detail, and it is deliberately deferred to this increment rather than blocking Increment 0.

1. **`wrangler deploy --dry-run` fails on this repository.** `wrangler.toml:3` is a Pages config (`pages_build_output_dir = ".svelte-kit/cloudflare"`). Running the command produces `▲ WARNING It seems that you have run 'wrangler deploy' on a Pages project`, then `✘ ERROR Missing entry-point to Worker script`, and exits nonzero. Verified empirically. It appears in Task 1 Step 6 ("Expected: every command exits 0") and Task 6 Step 2's clean release suite, so both gates fail on first run. Worse, Task 1 Step 4 names it as the *acceptance source*: "Do not guess the binding API: the generated type file and `wrangler deploy --dry-run` are the acceptance source." That instruction cannot be followed on a Pages project.

2. **The rate-limit binding does not exist on Pages, and the types will not tell you.** Verified: adding `[[ratelimits]]` to a copy of this Pages config and running `wrangler types` (4.110.0) emits `CAMPAIGN_LIMITER: RateLimit` with no error — but rate limiting is not a supported Pages Functions binding, so it is `undefined` at runtime. Task 1 Step 5 requires that campaign mutations "fail closed" when the shared binding is missing. Composed with a binding that silently type-checks and is always absent, that guard takes campaigns down in production *after every gate has passed green*. This is the plan's own safety mechanism producing the outage.

   Decide one of:
   - **Migrate to Workers.** `@sveltejs/adapter-cloudflare` supports both targets. This makes `[[ratelimits]]` and `wrangler deploy --dry-run` real, at the cost of a deployment migration on the release path.
   - **Stay on Pages** and implement the shared limiter another way — a Cloudflare dashboard WAF rate-limit rule, or a D1/KV-backed counter. Then delete both the `[[ratelimits]]` binding and the `wrangler deploy --dry-run` gate from this plan, and rewrite Task 1 Step 4's acceptance source.

   Do not proceed with the plan as written under either choice; it currently assumes Workers while the repository is Pages.

3. **The in-memory limiter claim is accurate but narrower than stated.** Specification §11's "existing per-isolate in-memory limiter" is real — `src/hooks.server.ts:26` (`writeBuckets` Map), `:25` (60 writes/60 s), `:66` (`isRateLimited()`) — and characterizing it as development-only defense is fair. But `:67` scopes it to `/api/` paths with mutating methods, so **polling GETs are entirely unlimited today**. This plan's `session-poll` policy therefore has no existing behavior to degrade to if the shared limiter is absent. Account for that in the fail-closed design.

4. **`tarot-art:verify` cannot run in the clean release suite.** Task 6 Step 2 includes it, but it rebuilds from the gitignored `assets-src/`. Use the `tarot-art:verify:ci` variant added by the art plan's amendment 2.

## Global Constraints

- Increment 4 and the tarot artwork pipeline must both be complete.
- Public enablement is configuration, not removal of the feature gate. `CAMPAIGNS_ENABLED=false` must remain a tested immediate rollback.
- Workers Paid is required unless the measured staging load test proves a documented alternative with at least 30% capacity headroom.
- Production rate limiting must be shared/edge-enforced. The process-local `Map` in `src/hooks.server.ts` is not a production control.
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

- [ ] **Step 1: Write failing policy tests**

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

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/unit/campaign-rate-limit.test.ts tests/integration/campaign-rate-limit.test.ts`

Expected: FAIL because the shared port does not exist.

- [ ] **Step 3: Implement provider-neutral policy selection**

`campaign.ts` derives a hashed bucket key from actor/campaign/IP facts and calls the injected port. Raw IDs and addresses do not go into provider analytics. The memory implementation is deterministic/injectable-clock and used only for local/test. Campaign endpoints call the service after authentication when possible but before expensive state reconstruction.

- [ ] **Step 4: Implement the Cloudflare binding adapter**

Add a dedicated rate-limit binding to `wrangler.toml` following the currently installed Wrangler schema, generate platform types with `npx wrangler types`, and expose the exact generated binding type in `App.Platform.env`. The adapter calls the binding's limit method, maps success/failure to `RateLimitDecision`, and fails closed for mutations but permits one degraded read/poll with a warning counter if the provider is temporarily unavailable.

Do not guess the binding API: the generated type file and `wrangler deploy --dry-run` are the acceptance source. Keep generated environment types committed only if that is already the repository convention; otherwise copy the minimal generated interface into `app.d.ts` with a source comment.

- [ ] **Step 5: Restrict the old hook limiter**

Keep the `Map` limiter only when no production binding is present. In production with campaigns enabled, startup/first request must fail closed for campaign mutations if the shared binding is missing. Existing noncampaign API behavior may retain its current local limiter.

- [ ] **Step 6: Run and commit**

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

- [ ] **Step 1: Write failing redaction tests**

Feed metrics/error helpers objects containing invite/card/character canaries and assert serialized sink calls include only names, counts, durations, status/rejection codes, retries, and coarse role/procedure labels.

- [ ] **Step 2: Define a fixed metric allowlist**

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

- [ ] **Step 3: Add an authenticated internal health endpoint**

Use a dedicated deployment secret and constant-time comparison. Report feature flag, D1 reachability, current content/runtime digest, migration presence, rate-limit binding presence, counts of active/frozen sessions, and oldest frozen age. Return aggregate data only. Disable entirely when the internal secret is absent.

- [ ] **Step 4: Run and commit**

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

- [ ] **Step 1: Create a non-destructive staging smoke harness**

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

- [ ] **Step 2: Apply migrations to a dedicated staging database**

Run:

```bash
npm run db:migrate:d1:remote
ADAPTER=cloudflare npm run build
npx wrangler pages deploy .svelte-kit/cloudflare --project-name guild-book-staging
node scripts/campaigns/staging-d1-smoke.mjs
```

Expected: migrations apply once, deployment succeeds, smoke script exits 0. Confirm the Wrangler environment points to staging—not production—before the migration command; document the actual environment-qualified command in the runbook.

- [ ] **Step 3: Record constraint evidence**

The runbook includes migration IDs, staging database ID, deployment commit, smoke fixture prefix, each contention result, and cleanup/archive outcome. Do not include invite URLs/tokens, session secrets, user auth tokens, or card identities.

- [ ] **Step 4: Commit staging tools**

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

- [ ] **Step 1: Automate recovery scenarios**

Test corrupt fragment/version mismatch detection, automatic freeze, GM recovery after valid fragment repair/reload, GM sanitized end when recovery cannot proceed, overnight active session across deployment, and campaign archive blocked while frozen.

- [ ] **Step 2: Rehearse configuration rollback on staging**

1. Start an active staging session and record its safe aggregate health.
2. Deploy `CAMPAIGNS_ENABLED=false` and empty pilot allowlist.
3. Verify campaign/join/API routes return `404`; character, rules, denizens, deck, login, and sharing still work.
4. Restore only operator pilot access, recover/end the session, verify public history.
5. Re-enable staging and verify no data migration rollback was required.

- [ ] **Step 3: Document the forward-only rollback**

The runbook states who can flip flags, expected propagation time measured in rehearsal, how to identify/freeze affected sessions using aggregate IDs in secure operator tooling, privacy-safe evidence collection, and escalation. It explicitly forbids dropping tables or deleting journals/secrets as rollback.

- [ ] **Step 4: Run and commit**

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
