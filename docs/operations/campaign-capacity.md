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

> **Amendment, 2026-07-28 (Arrowed) — the paragraph above is probably wrong, and
> in the unsafe direction.** It reasons about the client→colo hop only. It omits
> the colo→D1-primary hop, which for a request path made of sequential dependent
> D1 statements is the term that dominates. A developer sitting near the same
> region as the staging D1 primary is close to the *best* case for that term, not
> the worst: their Worker executes beside the database. A player in Seattle gets a
> nearby colo but the same distant primary. The 03:00 UTC datacenter run below is
> the first evidence for this and is consistent with it, but does not prove it —
> nothing here yet separates wire time from server time. **The thresholds are
> unchanged.** What changes is that a workstation run must no longer be described
> as conservative; until the instrumentation described in "What the next run must
> measure" lands, treat its absolute numbers as un-calibrated.

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

### 30-minute gate run — 2026-07-28, 00:26–00:56 UTC: **FAILED**

Nine campaigns, 27 clients, 1800s, against `guild-book-staging`.

| Gate | Threshold | Observed | Result |
| --- | --- | --- | --- |
| Max visible-change latency | ≤ 2000 ms, 100% | **6853 ms** | **FAIL** |
| Poll p95 | ≤ 1200 ms | 759.2 ms | PASS |
| Command p95 | ≤ 2000 ms | 1179.9 ms | PASS |
| Error rate | < 0.1% | 0.0052% (2 of 38 408) | PASS |
| Lost / duplicated command | zero | 1 lost / 0 duplicate | **FAIL** (see below) |

| Metric | Observed |
| --- | --- |
| Poll requests | 35 581 (`204` no-change 81.32%) |
| Poll latency p50 / p95 / p99 / max | 204.5 / 759.2 / 1123.8 / 4753.6 ms |
| Commands attempted / accepted / errors | 2827 / 2827 / 0 |
| Command latency p50 / p95 / p99 / max | 665.7 / 1179.9 / 1605.0 / 5073.1 ms |
| Visible-change observations | 5651 |
| Visible-change p50 / p95 / p99 / max | 842.0 / 1598.0 / **1959.0** / **6853.0** ms |
| Observations > 1500 ms | 422 (7.5%) |
| Observations > 2000 ms | **51 (0.90%)** |
| Harness event-loop lag p50 / p95 / max | 1.5 / 2.6 / 45.9 ms |
| HTTP-observable read / write proxy | 38 406 reads / 2827 writes |

#### The failure is a thin tail, not broad slowness

p99 is **1959 ms — inside budget**. 99.1% of observations met the 2-second
bound. The design is not generally too slow; it has a tail that breaches.

#### The outliers are real, not harness artifacts

This matters because this harness exists partly because an earlier gate run
failed at 5477 ms from the harness's *own* event-loop lag (see the file header).
Not this time: **maximum event-loop lag in the 3 seconds before every single
>2000 ms outlier was 2.5–2.9 ms.** The harness was keeping up. These are real
server or network latencies.

#### The outliers are bursty and correlated across campaigns

They cluster into specific minutes — 9 in `00:38`, 6 in `00:54`, 6 in `00:36` —
and within a burst they hit *different* campaigns within the same second
(`00:38:43`–`00:38:49` spans campaigns 0, 5, 6 and 7). Poll max (4753 ms) and
command max (5073 ms) fall in the same windows. That is the signature of a
**shared bottleneck**, not a per-campaign problem.

Two candidates, and this run cannot distinguish them:

1. **D1 contention.** All nine campaigns share one database, and D1 is
   sequential per database — precisely the behaviour this increment's Global
   Constraints require measuring. Steady state was ~19.8 polls/s of reads plus
   ~1.6 writes/s against a single database.
2. **The measurement path.** The harness runs from a developer workstation over
   a residential connection to a single colo. A local network or ISP hiccup
   produces exactly this correlated-burst shape.

**Distinguishing them is the next diagnostic step, and must happen before any
redesign is considered.** Re-run from a cloud VM in the same region as the colo:
if the tail disappears, it was the measurement path; if it persists, it is D1.
Cross-check against the D1 dashboard's own latency metrics for the run window.

#### The "1 lost command" is probably a measurement artifact

Under the rule in force during this run, a command was counted lost if no client
observed it and it was accepted more than 3150 ms before the window closed. With
a demonstrated tail of 6853 ms, a command accepted ~4 s before the close could
still have been propagating normally and been miscounted.

Evidence against real data loss: **0 duplicate resulting versions across 2827
accepted commands**, 2827/2827 accepted, and 0 command errors. Nothing indicates
a lost write.

The grace rule has since been corrected to one poll cycle plus the run's *worst
observed* propagation (never less than 2000 ms). That is a fix to measurement
validity, **not** a relaxation of the gate — the threshold is still zero. This
run's figure cannot be re-derived without re-running, so it stands as recorded.

#### What must not happen next

Per this increment's Global Constraints: *"Do not add Durable Objects,
WebSockets, or a full VTT as a release shortcut. If polling misses the gate, stop
rollout and redesign explicitly."*

So, explicitly forbidden as a response to this result:

- Raising the 2000 ms bound. It is spec Gate C, not a tuned value.
- Re-reading the gate as "p99 ≤ 2000 ms" without a spec amendment. p99 passes;
  the spec says 100%.
- Tuning `HINT_FRESH_MS` in `latest-cursor.ts` to make the number go away.
- Lengthening the poll interval to reduce load.

Any of those may turn out to be the *right* decision — but each is a deliberate,
recorded architecture decision, not a fix to apply quietly.

### 30-minute datacenter re-run — 2026-07-28, 03:00–03:30 UTC: **FAILED**

The diagnostic the previous section called for: the identical harness, identical
scenario, run from GitHub Actions (`.github/workflows/capacity-gate.yml`) instead
of a developer workstation, to test whether the tail was the residential network.

| Gate | Threshold | Observed | Result |
| --- | --- | --- | --- |
| Max visible-change latency | ≤ 2000 ms, 100% | **9898 ms** | **FAIL** |
| Poll p95 | ≤ 1200 ms | **2109.3 ms** | **FAIL** |
| Command p95 | ≤ 2000 ms | **2707.8 ms** | **FAIL** |
| Error rate | < 0.1% | 0.0000% (0 of 26 404) | PASS |
| Lost / duplicated command | zero | 0 lost / 0 duplicate | PASS |

| Metric | Observed |
| --- | --- |
| Poll requests | 24 182 (`204` no-change 74.29%) |
| Poll latency p50 / p95 / p99 / max | 605.1 / 2109.3 / 2384.9 / 2847.8 ms |
| Commands attempted / accepted / errors | 2222 / 2222 / 0 |
| Command latency p50 / p95 / p99 / max | 2247.6 / 2707.8 / 2964.1 / 3882.5 ms |
| Visible-change observations | 4441 |
| Visible-change p50 / p95 / p99 / max | 1415.0 / 2288.0 / 2574.0 / **9898.0** ms |
| Observations > 1500 ms | 1987 (44.7%) |
| Observations > 2000 ms | **682 (15.4%)** |
| Harness event-loop lag p50 / p95 / max | 0.2 / 1.1 / 3.4 ms |
| HTTP-observable read / write proxy | 26 404 reads / 2222 writes |

#### It is a different failure from the 00:26 run, not a worse one

| | 00:26 workstation | 03:00 GitHub Actions | Ratio |
| --- | --- | --- | --- |
| Poll p50 | 204.5 ms | 605.1 ms | 2.96× |
| Poll p95 | 759.2 ms | 2109.3 ms | 2.78× |
| Command p50 | 665.7 ms | 2247.6 ms | 3.38× |
| Command p95 | 1179.9 ms | 2707.8 ms | 2.30× |
| Visible p50 | 842.0 ms | 1415.0 ms | 1.68× |
| Observations > 2000 ms | 0.90% | 15.4% | — |

The 00:26 run was fast with a thin breaching tail: p99 was 1959 ms, inside
budget, and only 0.90% of observations breached. This run's whole distribution
moved up. Its p99 (2574 ms) is outside budget on its own. Nothing here is a tail
phenomenon; the poll p95 and command p95 gates failed for the first time.

#### The run went ~3× slower while offering ~32% less traffic

The harness is closed-loop: each client awaits its response before sleeping, so
slower responses mechanically reduce the request rate.

| | 00:26 workstation | 03:00 GitHub Actions |
| --- | --- | --- |
| Polls in the 1800 s window | 35 581 (19.8/s) | 24 182 (13.4/s) |
| Commands in the window | 2827 (1.57/s) | 2222 (1.23/s) |

Both loops match their own latency exactly: the command loop sleeps 5000 ms and
saw a 2247 ms p50, giving a ~7.25 s cycle, which over nine campaigns predicts
2234 commands against 2222 observed.

**This is the load-bearing observation.** Contention degrades as offered load
rises. This run offered 32% fewer reads and 21% fewer writes to the same single
database and was three times slower. That is the signature of added *fixed cost
per request*, not of queueing at D1 — which makes the "D1 contention" candidate
from the 00:26 post-mortem the weaker of the two, not the stronger.

Corroborating: the 00:26 outliers clustered into specific minutes (`:36`, `:38`,
`:54`) and hit different campaigns within the same second — the burst shape that
suggested a shared bottleneck. In this run they are spread evenly across all
thirty minutes. The burst signature is gone.

#### The harness is again exonerated

Event-loop lag maxed at **3.4 ms** across 35 981 samples, and the maximum lag in
the 3 s preceding each of the 682 breaching observations never exceeded 3.4 ms.
Zero errors in 26 404 requests, zero lost commands, zero duplicate resulting
versions across 2222 accepted. The latency is the server's or the network's.

#### The experiment did not answer its question, and could not have

The 00:26 post-mortem asked for "a cloud VM in the same region as the colo."
`ubuntu-latest` is not that: it is an Azure runner whose region is not
selectable. So this run did not remove the network variable, it substituted a
different and worse-performing unknown path for it. It cannot distinguish the
two candidates any more than the first run could.

The reason it could not is structural, and applies to every future run too:

```
src/lib/server/observability/campaign-metrics.ts   setCampaignMetricSink()
```

was never called outside tests, so `recordPoll()` and `recordCommandOutcome()`
were **no-ops in the deployed Worker**. Every number in both post-mortems is
client-observed wall clock with no way to subtract the network. Two runs have now
ended at "we cannot tell whether it is the network or D1." A third, framed the
same way, ends there as well.

#### Leading hypothesis, explicitly unconfirmed

Latency on the command path is bound by *round-trip count × Worker-to-D1-primary
distance*, not by D1 throughput. `session/command-service.ts` runs a chain of
dependent awaits — `findSessionCommand` → `loadSessionForReduce` → reduce →
commit → `loadProjectionForActor` — each helper itself several statements, none
of which can be batched away because each depends on the last. A Worker
co-located with the D1 primary pays almost nothing per hop; a distant one pays a
full cross-region RTT per statement.

This predicts exactly the observed asymmetry: commands (many dependent hops)
inflated 3.38× while polls (few hops, and 74% answered from the isolate-local
cursor hint with no D1 read at all) inflated 2.96×.

**It is a hypothesis. It has not been measured, and must not be acted on until it
is.** In particular it is not a licence to start batching queries — that would be
optimising against an unverified model.

#### What the next run must measure

Server-side timing, so the split is read off directly rather than argued about:

- `srv` — wall time inside the Worker, from `hooks.server.ts` around `resolve()`
- `d1` — cumulative wall time inside D1 calls, and `n`, the number of round trips
- the serving Cloudflare colo, so the geography is recorded and not inferred

Delivered as a `Server-Timing` response header (staging-gated behind
`CAMPAIGN_TIMING_HEADER`), recorded per request by the load harness, and reported
alongside the existing latency percentiles. `total − srv` is then the wire, and
`srv − d1` is Worker CPU plus non-D1 awaits.

The decision rule for the next run, written down before it is run:

- **`d1` small and `total − srv` large** → the path, not the database. The
  Global Constraints' redesign clause is not triggered; the gate needs a
  measurement location that represents real players, and the thresholds need
  re-deriving against it.
- **`d1` large with a small `n`** → D1 execution or contention. Redesign
  discussion is live.
- **`d1` large with a large `n`** → round-trip-bound, as hypothesised above.
  The lever is the number of dependent statements per request, which is an
  architecture decision to be recorded, not a quiet optimisation.

### 30-minute instrumented gate run — 2026-07-28, 17:49–18:19 UTC: **FAILED**

The first run with server-side timing. Nine campaigns, 27 clients, 1800s, from
GitHub Actions (colo `IAD`) against `guild-book-staging` (D1 primary `MIA`).
30 642 requests, zero errors, zero lost or duplicated commands.

| Gate | Threshold | Observed | Result |
| --- | --- | --- | --- |
| Max visible-change latency | ≤ 2000 ms, 100% | **8260 ms** | **FAIL** |
| Poll p95 | ≤ 1200 ms | **1556.4 ms** | **FAIL** |
| Command p95 | ≤ 2000 ms | **2090.9 ms** | **FAIL** |
| Error rate | < 0.1% | 0.0000% | PASS |
| Lost / duplicated command | zero | 0 / 0 | PASS |

#### Where the time goes

```
poll     mean 648.2ms  =  37.9ms wire  +   610.2ms D1  +  0.2ms worker
         8.68 round trips  —  79.6ms each  —  1.13x average concurrency

command  mean 1625.7ms =  57.1ms wire  +  1568.4ms D1  +  0.2ms worker
         20.00 round trips carrying 26 statements  —  78.4ms each  —  1.00x concurrency
```

**It was never the network.** The wire is 5.8% of a poll and 3.5% of a command.
D1 round trips are 94% and 96.5%. Worker CPU is nil — as expected, since the
Workers clock advances on I/O rather than CPU.

**Commands achieve no parallelism at all.** 1.00× concurrency means all twenty
round trips are on the critical path in sequence. There is no overlap left to
exploit; the only lever on command latency is a smaller number of dependent
round trips.

#### Both original candidates were real, and are now separable

| Measurement | ms per D1 round trip |
| --- | --- |
| Workstation → `MIA` colo, co-located with the primary (single-query route) | 10–26 |
| GH runner (`IAD`) → `MIA` primary, 2 campaigns | 47.2 |
| GH runner (`IAD`) → `MIA` primary, 9 campaigns | **79.6** |

There is a **distance floor of roughly 45–50 ms** per round trip on this path,
plus a **load-dependent component of about +30 ms** at pilot concurrency. So D1
contention is real — it is simply not the dominant term, and it could never
have been seen until the distance term was subtracted out. Neither earlier run
could have distinguished these.

Steady state was **163 D1 round trips per second** against a single database for
nine campaigns and 27 players (293 634 measured round trips over 1800 s).

#### Verdict against the pre-registered decision rule

The rule recorded before the run named three outcomes. This run is
unambiguously the third: **`d1` large with a large `n` — round-trip-bound.**
Per that rule and the increment's Global Constraints, the response is a
recorded architecture decision, not a quiet optimisation.

### Where the round trips actually go

Counts below are traced from the code and reconciled against the measured
distribution (poll p50 = 6, poll p95/max = 18, command = 20 exactly). They are
**not** per-call-site instrumented; adding a call-site tag to `RequestTiming`
would confirm them directly and is the honest next measurement if any of these
numbers are to be relied on individually.

**Every authenticated campaign request pays three round trips before any route
logic runs:**

| # | Where | Query |
| --- | --- | --- |
| 1 | Auth.js `jwt` callback (`auth-policy.ts`) | `SELECT … FROM users WHERE id = ?` |
| 2 | `ensureUser` (`auth.ts:141`) | `SELECT id FROM users WHERE id = ?` |
| 3 | `resolveCampaignAccess` (`campaign/access.ts`) | `campaigns` ⨝ `campaign_members` |

Rows 1 and 2 read **the same `users` row twice** in the same request.

The activity *write* in `recordActivity` is not a per-request cost —
`activityPatch` caps it at one write per user per day. Only the read is
per-request.

**That fixed cost is paid by the 76.8% of polls that return `204`.** The
isolate-local cursor hint in `latest-cursor.ts` short-circuits the route's own
queries, but it is consulted *after* authorization, so a hint-answered no-op
still costs three round trips — about 240 ms at the rate this run measured.

| Request | Round trips | Composition |
| --- | --- | --- |
| Poll, hint-answered `204` | 3 | auth only |
| Poll, authoritative `204` | ~5 | auth + `campaignCursor` ∥ `findOpenSessionForCampaign` |
| Poll, `200` with events | ~18 | + events + secrets + `loadTableProjectionsForActor` |
| Command | 20 | auth + `executeCommand` chain, twice through `loadSessionForReduce` |

Two structural repetitions account for most of the rest:

1. **`loadSessionForReduce` is five sequential queries** (`playSessions`,
   campaign owner, runtime content, `sessionServerStates`,
   `sessionPrivateStates`) and it runs **twice per command** — once to reduce
   the command, then again inside `loadProjectionForActor` to build the
   response.
2. **`campaignCursor` is queried twice per changed poll** — once in
   `sync/+server.ts` and again inside `loadTableProjectionsForActor`.

### What reducing this would require

Not a decision this document makes. Recorded so the decision can be made with
numbers rather than instinct. Estimated savings use this run's 79.6 ms per
round trip, which is specific to `IAD`→`MIA` at pilot load.

| # | Change | Saves | Risk |
| --- | --- | --- | --- |
| A | Reuse the `users` row the `jwt` callback already read instead of re-reading it in `ensureUser` | 1 round trip on **every** request (~80 ms) | Low. Same row, same request. |
| B | Reuse the session already loaded for the reduce when building the command's response projection | 5 round trips per command (~400 ms) | Medium. Must not return pre-commit state. |
| C | `batch()` the independent reads inside `loadSessionForReduce` — server state and private states do not depend on each other | ~3 round trips wherever it is called | Medium. One batch is one round trip; the dependent reads must stay ordered. |
| D | Cache the authorization result per (user, campaign) in the isolate with a short TTL, as `latest-cursor.ts` already does for cursors | up to 3 round trips on ~77% of polls | **High. This is authorization.** A stale grant is a security failure, not a slow response. Needs its own design and review. |
| E | Drop the second `campaignCursor` on a changed poll | 1 round trip per `200` | Low. |

A + B + C + E together would take a command from 20 round trips to roughly 11,
and a changed poll from ~18 to ~11 — on this path, command mean ~1600 ms →
~870 ms. That is inside the 2000 ms command budget with margin, and none of
those four changes weakens a security boundary.

D is the only one that touches the no-op poll path, which is 76.8% of all
traffic, and it is also the only one that touches authorization. It should be
considered separately and last.

**What none of this changes:** the distance floor. Every remaining round trip
still costs ~45–50 ms from `IAD` to a `MIA` primary. Reducing the count is the
lever available in application code; moving the data closer to the reader (D1
read replication / the Sessions API) is a different decision with its own
consistency implications, and is out of scope for this document.

### Open question: which location the thresholds describe

This run measured `IAD`→`MIA`. That is *a* real-player geometry, not *the* one:
a player near Miami gets the co-located case at 10–26 ms per round trip, and a
player in Seattle gets something worse than `IAD`. The gate now measures
honestly, but **the location the thresholds are defined against is a product
decision that has not been made.** Until it is, a pass or fail here describes
one point on a distribution, not the pilot's experience.

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
