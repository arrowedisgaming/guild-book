# Campaign Pilot Operations

Operational reference for running the allowlisted shared-tarot-table pilot
(Increment 2). This is not a design document — see
`docs/superpowers/specs/2026-07-15-campaigns-shared-tarot-design.md` and the
increment plans under `docs/superpowers/plans/` for the "why". This page is
the "what do I actually do" reference for whoever operates the pilot.

**Status at the end of Increment 2:** `CAMPAIGNS_ENABLED` remains `false` in
every deployed environment. Nothing in this document authorizes turning the
feature on for the general public — it describes how to run it for a small,
named allowlist once someone with deploy access decides to.

---

## 1. Workers Paid is required before any real pilot traffic

The table's live view polls `GET /api/campaigns/[id]/sync` on a roughly
one-second cadence per open client (see
`src/lib/stores/campaign-session.svelte.ts`). Cloudflare Workers Free is
capped at 100,000 requests/day and 10ms CPU time per request; a handful of
concurrent pilot sessions left open for a session's length will exceed the
free daily request allowance well before the free CPU-time ceiling becomes
the binding constraint. Workers Paid (currently a $5/month minimum) lifts
both limits to effectively unlimited requests and 30s default CPU per
request.

**Do not enable `CAMPAIGNS_ENABLED` (or add pilot users) against a Workers
Free account.** Confirm the account is on Workers Paid before the first pilot
session, and re-confirm after any billing or account change that could
silently downgrade the plan (shared accounts, lapsed payment methods, etc.).

This project has no WebSocket or Durable Object dependency in v1 — the whole
design is plain HTTP polling against D1 through ordinary Workers requests.
Workers Paid is required for request/CPU headroom, not because the
architecture needs a stateful/real-time primitive it doesn't have.

---

## 2. Allowlist setup

Pilot access is gated by two server-only environment variables (already
documented in `.env.example`):

```bash
CAMPAIGNS_ENABLED=false            # keep false for a named-allowlist pilot
CAMPAIGNS_PILOT_USER_IDS=id1,id2   # comma-separated Guild Book user ids
```

`canAccessCampaignFeature` (`src/lib/server/campaign/config.ts`) grants
access when *either* `CAMPAIGNS_ENABLED` is on *or* the signed-in user's id is
in `CAMPAIGNS_PILOT_USER_IDS`. For the pilot, leave `CAMPAIGNS_ENABLED=false`
and populate only the allowlist — that keeps every campaign route (and the
`/campaigns` nav entry point) a 404 for everyone else, identical to the
feature simply not existing.

**Finding a pilot user's id.** Guild Book's user id is an internal `nanoid`,
not the person's email — there is no admin UI for this yet. The pilot
candidate must sign in at least once (via Google or Discord) so their `users`
row exists, then an operator with D1 access looks it up:

```bash
npx wrangler d1 execute guild-book-db --remote \
  --command "SELECT id, name, email FROM users WHERE email = 'person@example.com'"
```

Add the returned `id` to `CAMPAIGNS_PILOT_USER_IDS` (comma-separated, no
spaces) and redeploy the environment variable. Removing an id from the list
revokes their access immediately on their next request — no session
invalidation needed, since access is re-checked on every request via
`requireCampaignFeature`.

---

## 3. Session lifecycle: start / freeze / recover / end

All four transitions are GM-only and go through
`src/lib/server/session/lifecycle.ts`. The table UI's "Start session" button
covers start; the other three currently have no dedicated UI control (Task 7
scope) and are reached directly through the API. This section is the
reference for an operator (or a GM the operator is walking through it)
driving them by hand.

### Start

Normal path: the GM opens `/campaigns/[id]/table` and clicks **Start
session**. Equivalent direct call:

```bash
curl -X POST "$BASE/api/campaigns/$CAMPAIGN_ID/sessions" \
  -H "Content-Type: application/json" -H "Origin: $BASE" \
  -b "$GM_COOKIES" -d '{}'
```

Fails with 409 (`illegal-command`) if a session is already active or frozen
for that campaign — a campaign has at most one open session at a time.

### Freeze

Use this the moment something looks wrong mid-session (see §5, privacy
incident response, for the specific case that matters most). Freezing stops
all further commands against the session without ending it — the table
becomes read-only for every participant until a GM recovers or ends it.

```bash
curl -X PATCH "$BASE/api/campaigns/$CAMPAIGN_ID/sessions/$SESSION_ID" \
  -H "Content-Type: application/json" -H "Origin: $BASE" \
  -b "$GM_COOKIES" -d '{"action":"freeze"}'
```

`expectedVersion` is optional on all three PATCH actions — omit it (as
above) when you need to freeze immediately and don't want a stale-version
race to block the freeze; supply it (from a prior session read) when you
specifically want the freeze to no-op if something else changed the session
first. Freezing an already-frozen or already-ended session is rejected
(400/`illegal-command`) rather than silently accepted.

### Recover

Returns a frozen session to active, letting play resume:

```bash
curl -X PATCH "$BASE/api/campaigns/$CAMPAIGN_ID/sessions/$SESSION_ID" \
  -H "Content-Type: application/json" -H "Origin: $BASE" \
  -b "$GM_COOKIES" -d '{"action":"recover"}'
```

Only valid from `frozen`. Recovering an active or ended session is rejected.

### End

Closes the session for good and stamps its public-history checksum. There is
no "un-end" — starting again creates a brand new session.

```bash
curl -X PATCH "$BASE/api/campaigns/$CAMPAIGN_ID/sessions/$SESSION_ID" \
  -H "Content-Type: application/json" -H "Origin: $BASE" \
  -b "$GM_COOKIES" -d '{"action":"end"}'
```

Valid from `active` or `frozen`.

---

## 4. Logs that are safe to inspect

By design, the session layer never logs a card identity, a private payload,
or any other secret — this is asserted directly by
`tests/integration/session-privacy.test.ts`'s "never logs either secret to
the console across the whole scenario" canary, which drives a full
draw/reveal/sync/end flow with a spied `console.*` and asserts nothing
secret-shaped was ever passed to it.

The session layer has exactly two log call sites, both diagnostic-only and
both safe for an operator to read without special handling:

- `src/lib/server/session/repository.ts` — `recordFreshCursorHintAfterCommit`
  logs via `console.debug` if its own advisory post-commit cursor-hint
  refresh fails. This never blocks or fails the write it follows; it only
  means the next `/sync` poll on that isolate falls back to a real DB read
  instead of a cached hint.
- `src/lib/server/session/command-service.ts` — logs via `console.error` if
  building a post-command actor projection throws unexpectedly. The logged
  value is the caught JS error/cause, not any part of the command or session
  state.

Every other diagnostic signal available to an operator (Cloudflare's request
logs, D1 query logs, Workers analytics) operates below the application layer
and only ever sees what already crossed the wire — which is itself
role-scoped per recipient (see the privacy canary inventory in the
Increment 2 completion record). There is no separate "debug logging" mode to
avoid enabling in production.

---

## 5. Privacy incident response

If a pilot participant reports (or an operator otherwise suspects) that a
private card, hand, or zone was visible to someone who shouldn't have seen
it:

1. **Freeze the session immediately** (§3, above) — this is the fastest way
   to stop further play without destroying evidence. Freezing does not clear
   any state; every private zone, hand, and event history is intact for
   investigation.
2. **Do not end the session** until the cause is understood — ending
   triggers the public-history snapshot / private-state cleanup path, which
   is the right outcome eventually but forecloses re-reading the live
   projection while investigating.
3. **Investigate against the same privacy invariants the test suite
   enforces**: read `tests/integration/session-privacy.test.ts` for the
   canonical list of what must never cross a role boundary, and check the
   actual response bodies/events involved in the report against that list —
   own-secret-only session reads, role-scoped `/sync` events, no secret in
   HTTP headers, no secret in the coarse session-list endpoint, no secret in
   an uninvolved actor's command outcome. The Increment 2 completion record
   (`docs/superpowers/2026-07-18-campaigns-increment-2-completion.md`) lists
   every canary case as of this gate, for cross-reference against what
   changed since.
4. **Recover the session once the cause is fixed and verified** (a new
   deploy, if the cause was code), or **end it** if the campaign should not
   continue. Either way, tell the affected participants what happened before
   resuming their access.
5. **Escalate to a full incident writeup** if the leak reached a real card
   identity a role boundary should have hidden (not just a UI/wording
   glitch) — this is a correctness failure in the privacy guarantee the
   whole feature is built on, and should not be quietly patched without a
   record of what leaked and to whom.

---

## 6. Feature-disable rollback

The rollback for anything pilot-related, from "one participant is causing
trouble" to "something is systemically wrong with the shared table", is the
same lever at two different scopes:

- **Revoke one person:** remove their id from `CAMPAIGNS_PILOT_USER_IDS` and
  redeploy the environment variable. Their next request 404s exactly like
  the feature never existed for them — no session termination step needed,
  no data is deleted.
- **Disable the whole pilot:** set `CAMPAIGNS_ENABLED=false` and clear (or
  leave — it's inert once `CAMPAIGNS_ENABLED` is false and nobody's id is in
  it) `CAMPAIGNS_PILOT_USER_IDS`, then redeploy. Every campaign route 404s
  for everyone immediately. Any session left active/frozen at that point
  simply stops being reachable — it is not auto-ended, so re-enabling later
  resumes exactly where it left off.

There is no data-destructive step in either rollback. Campaigns, sessions,
and their event history are ordinary D1 rows; disabling the feature flag
only removes HTTP reachability, per `requireCampaignFeature`.

---

## 7. Running the load gate

`tests/load/session-polling.mjs` is the Task 8 pilot-readiness load script
(plain Node, no dependencies beyond the runtime's built-in `fetch`). It
simulates nine campaigns of three authenticated polling clients each (one GM,
two players) polling `/sync` at the table's production cadence, while each
campaign's GM periodically issues a always-legal `end-round` command so the
script can measure how long an accepted public change takes to reach the
other two clients' next poll.

Two ways to run it, both supported (controller amendment 1):

**Self-booted (default)** — the script seeds a fixture SQLite DB at
`.tmp/guild-book-load-<run-id>.db` (a fresh, uniquely-named file per
invocation, never `local.db` or the e2e suite's fixture DB), runs
`npm run build`, starts `vite preview`, waits for it to answer, runs the
load window, then tears the preview server down and deletes that run's DB
file (including its WAL/SHM sidecars) — whether the run passed, failed, or
the server never came up in the first place. A boot failure kills the
spawned server and exits non-zero rather than hanging (fixed in review round
1 after the initial version could leave an unreachable child process
holding the script open indefinitely):

```bash
node tests/load/session-polling.mjs                      # full 10-minute gate
node tests/load/session-polling.mjs --duration 30         # 30s smoke run
```

**Against an already-running server** — point it at a server you started
yourself (e.g. `npm run preview` left running from a manual session), with
the same env `playwright.config.ts` uses (`NODE_ENV=development`,
`AUTH_DEV_LOGIN=true`, `CAMPAIGNS_ENABLED=true`, a fixture DB):

```bash
node tests/load/session-polling.mjs --base-url http://127.0.0.1:4173 --duration 30
```

In both modes, authentication goes through the dev-only Credentials provider
directly (`POST /auth/callback/credentials`) — the same mechanism
`tests/e2e/fixtures/auth.ts`'s `signInAs` drives through a real browser, just
called over plain HTTP here. This requires `AUTH_DEV_LOGIN=true` and
`NODE_ENV=development`; it is never available in a production deployment
(see `src/lib/server/auth.ts`), so this script cannot be pointed at a real
pilot environment — only at a disposable local/CI build.

The script fails (non-zero exit) if any accepted change takes more than two
seconds to become visible to another client, or if the overall request error
rate exceeds 0.1%. Full field-by-field results (poll latency percentiles,
204 rate, time-to-visible-event percentiles, request/error counts) print to
stdout — see the Increment 2 completion record for the real numbers from the
gate run this task produced.

### 7.1 Known harness limitation: single-process client fan-out

The script runs every simulated client (27 poll loops + 9 command loops, 36
concurrent async tasks) inside **one Node process**. The first full gate run
failed at max visibility latency 5477ms with poll-request latency staying
uniformly low throughout (p99 15.9ms, max 34.3ms) — the signature of a
harness-side stall, not a server or product delay: all 27 poll loops began
their very first cycle within the same ~150ms jitter window right after
setup, and that initial synchronized burst was enough to delay some clients'
own scheduled poll ticks by several seconds under event-loop contention. The
delay was invisible to the request-latency timer (it only starts once
`fetch()` is actually called, not when the client meant to call it), so it
only showed up in "time to visible," never in poll latency.

The fix — already applied in the committed script — is `assignPollStartOffsets`
in `tests/load/session-polling.mjs`: it deterministically spreads all N
clients' *first* poll across one full cadence window (`[0, pollIntervalMs)`)
instead of letting them all start together. Combined with an event-loop-lag
sampler (`startEventLoopLagSampler`, logged as `[lag]` lines and summarized
in the report) that measures the harness's own scheduling drift directly, a
re-run with the same 9-campaign/600s parameters passed clean: 2142
observations, max 1147ms, 0 observations over 1500ms, event-loop lag p99
2.8ms. See the Increment 2 completion record §7 for both runs' full numbers
and the diagnosis that connected them.

**If a future run of this script ever fails again with a high visibility
max but low poll latency, check the `[lag]` lines and the report's harness
event-loop-lag section before suspecting the product.** That combination is
the harness's own signature, not evidence of a real regression. If event-loop
lag is genuinely elevated at the same timestamps as the outliers (the report
prints this correlation automatically whenever any observation exceeds
2000ms), the honest fix is a fairer harness — e.g. spreading clients across
`worker_threads` or separate processes — not raising the 2-second threshold.

### 7.2 The gate cannot pass on an empty measurement

Review round 1 also caught a loophole in the original gate logic: it treated
zero visibility observations as an automatic PASS (nothing to fail on), so a
run that measured nothing at all — every command request erroring, or a
config mistake leaving the GM without permission to issue `end-round` —
would have reported success. The gate now requires **both** at least one
accepted command **and** at least one visibility observation before it will
report anything other than an explicit `FAIL (measured nothing — ...)`. A
green run must have actually measured something.
