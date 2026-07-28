# Campaign capacity and latency gates (Increment 5 Task 4)

## Thresholds — selected 2026-07-28, BEFORE the gate run

Task 4 Step 2 requires the p95 threshold and its rationale to be written down
before the measured run, so it cannot be moved once results are known. These are
those numbers. Changing any of them requires an explicit, dated amendment in
this section stating who changed it and why — not a silent edit.

| Gate | Threshold | Source |
| --- | --- | --- |
| Max accepted-change-to-visible latency | **≤ 2000 ms**, 100% of observations | Spec Gate C. Not negotiable, not a tuned value. |
| Poll (`/sync`) p95 | **≤ 1200 ms** | Product judgement, see below |
| Command p95 | **≤ 2000 ms** | Product judgement, see below |
| HTTP/application error rate | **< 0.1%** | Task 4 Step 2 |
| Projected monthly consumption headroom | **≥ 30%** against the selected paid limits | Task 4 Step 2 |
| Privacy canary leak | **zero** | Task 4 Step 2 |
| Lost or duplicated accepted command | **zero** | Task 4 Step 2 |

### Rationale for the two p95 numbers

*His Majesty the Worm* is a turn-based, deliberate game: a player draws, reads a
card, and talks about it. The binding product constraint is not raw latency but
the 2-second bound on how long an accepted change takes to become visible to
everyone else at the table, which Gate C already fixes. The p95 numbers exist to
catch *degradation* — a regression or a contention cliff — not to chase a number
no player would notice.

**Disclosed calibration:** a 60-second, 9-campaign, 27-client pilot was run
against staging on 2026-07-28 before these thresholds were set, and observed
poll p95 **757 ms** and command p95 **1313 ms**. The thresholds above are set
roughly 1.5× those observations to absorb the additional variance of a
30-minute window without being so loose that a real regression passes. Stating
this is more honest than presenting the numbers as though they came from
nowhere; what Step 2 forbids is moving them *after* the gate run, which is why
they are recorded here first.

**Measurement bias, and why it is the safe direction.** The harness runs from a
developer workstation over the public internet to a single Cloudflare colo
(`MIA` in the pilot). A real player's request terminates at their nearest colo.
Every latency figure here is therefore *inflated* relative to production, making
these gates harder to pass than reality — conservative, not flattering. Do not
"correct" for this by loosening the thresholds.

## Scenario

Nine simultaneous campaigns, each with a GM and two players (27 polling
clients), for 30 minutes:

- poll cadence 1000 ms + 0–150 ms jitter, matching `campaign-session.svelte.ts`
- each campaign's GM issues a visible `end-round` every 5000 ms
- all table pages "visible" for the steady-state window

```bash
CAMPAIGN_LOAD_TARGET=staging \
CAMPAIGN_STAGING_AUTH_SECRET=<staging AUTH_SECRET> \
node tests/load/session-polling.mjs \
  --base-url https://guild-book-staging.esoneill.workers.dev \
  --duration 1800 --campaigns 9

CAMPAIGN_LOAD_TARGET=staging \
CAMPAIGN_STAGING_AUTH_SECRET=<staging AUTH_SECRET> \
node tests/load/session-contention.mjs \
  --base-url https://guild-book-staging.esoneill.workers.dev
```

Both refuse to run against the production hostname.

## Results

### 60-second calibration pilot — 2026-07-28

Not a gate run. Recorded because it is what the thresholds above were calibrated
against, and because it is the first measurement of this application against
remote D1 at pilot concurrency.

| Metric | Observed |
| --- | --- |
| Poll requests | 1179 |
| `204` no-change ratio | 82.02% |
| Poll latency p50 / p95 / p99 / max | 193.8 / 757.1 / 1323.7 / 1610.9 ms |
| Commands attempted / accepted | 90 / 90 |
| Command latency p50 / p95 / p99 | 682.6 / 1313.1 / 1681.3 ms |
| Visible-change observations | 175 |
| Visible-change p50 / p95 / max | 783.0 / 1611.0 / **1874.0** ms |
| Observations > 1500 ms | 12 |
| Observations > 2000 ms | **0** |
| Errors | **0** (0.0000%) |
| Harness event-loop lag p95 | 2.5 ms (so the numbers are the server's, not the harness's) |

**The margin on the hard gate is thin.** Max visible-change latency reached
1874 ms against a 2000 ms bound — 94% of budget — in only 60 seconds. A
30-minute window has far more opportunity to exceed it. Treat a passing
30-minute run as the real evidence and this pilot as a warning that the cursor
polling design is close to its limit at this concurrency, not comfortably
inside it.

The 82% no-change ratio is the polling design working as intended: four of every
five polls cost a cursor comparison and no projection rebuild.

### 30-minute gate run

**Not yet run.** Record here: every metric in the table above, the actual
wall-clock window, the staging deployment version, and the pass/fail of each
threshold in the Thresholds section.

### Monthly consumption projection and headroom

**Not yet computed.** Requires the 30-minute run's steady-state request rate.
Derive: observed requests/second → projected monthly requests, D1 rows read and
written per operation class, against the Workers Paid included limits and the
agreed budget. Must show ≥ 30% headroom.

The read/write figures the harness prints are an **HTTP-observable proxy**, not
literal D1 instrumentation: every `200`/`204` sync is counted as one read, every
command attempt as one read, and every accepted command as one additional write.
Cross-check against the D1 dashboard's own metrics for the run window before
claiming headroom, and say which source each number came from.

## Durable Object upgrade trigger (Increment 5 amendment 2)

The Cloudflare rate-limit binding is **per Cloudflare location, not a global
counter**. A client spread across N colos obtains roughly N× the nominal limit.
That is acceptable for v1 — it is durable across isolate churn and stops a
single abusive or runaway client, which the process-local `Map` cannot.

Amendment 2 requires a written trigger for when a Durable Object-backed,
globally consistent limiter becomes justified. **The trigger is any one of:**

1. **A single actor exceeding 3× a policy's nominal limit** in a 60-second
   window, measured as accepted requests attributed to one hashed bucket key
   across all colos. 3× is chosen because 2× is reachable by an ordinary player
   travelling or on a carrier that shifts egress between colos, whereas 3×
   implies deliberate distribution.
2. **Sustained traffic above 50 requests/second** to campaign endpoints in
   aggregate, at which point per-colo counters diverge enough that the nominal
   limits stop describing real behaviour.
3. **Any confirmed abuse incident** where per-colo limiting demonstrably failed
   to contain a client, regardless of the numbers above.

Until one of those fires, the binding is the correct v1. The `SharedRateLimiter`
port exists so the swap needs no caller changes; Workers (per D4) is what keeps
the Durable Object option reachable at all.

## Blocking issue at time of writing

`rateLimit.enforcement` reports **`not-enforcing`** on staging and production.
The binding deploys and resolves but does not count — see `DEPLOY.md` and
`docs/operations/campaign-staging.md`.

Two consequences for this document:

1. **The "rate-limit false positives" metric Task 4 Step 1 asks for is not
   measurable.** A limiter that never denies cannot produce a false positive.
   The figure will read zero for a reason that is not the reassuring one, and
   must not be reported as evidence the limits are correctly tuned.
2. **Gate E cannot pass**, independently of any capacity result here. A green
   capacity run does not clear campaigns for public release while the limiter
   is inert.
