# Campaign capacity and latency gates (Increment 5 Task 4)

## Status — updated 2026-07-29, resume here

This section is the short version; everything below it is the evidence.

**Where it stands: 4 of 5 gates pass.** The latency problem is understood and
largely fixed, and the correctness question is now closed — it was a harness
miscount, diagnosed from the existing run log without a re-run. **Gate C is the
only remaining failure.**

| Gate | Status |
| --- | --- |
| Poll p95 ≤ 1200 ms | PASS at 1186.9 ms — **by 13 ms**, inside observed colo variance |
| Command p95 ≤ 2000 ms | PASS at 1535.1 ms, comfortable |
| Error rate < 0.1% | PASS at 0.0000% |
| Zero lost / duplicated commands | **PASS** — the "2 lost" was a harness miscount, fixed 2026-07-29 |
| Max visible-change ≤ 2000 ms (Gate C) | **FAIL at 2829 ms** — was 8260 ms |

**What was learned.** Latency here is bound by the NUMBER of sequential D1 round
trips, not by the network (3–6% of a request) and not by D1 throughput. Commands
run at 1.00× concurrency, so every round trip is on the critical path. Round
trips were cut from 20 → 10 per command and 8.68 → 5.88 per poll, which is what
moved both p95 gates from fail to pass.

**The 2 lost observations are resolved — no data was lost.** Diagnosed
2026-07-29 from the retained GitHub Actions log for the 23:41 run, so the
planned re-run was not needed. Both "losses" were the final command of campaigns
3 and 4, accepted *after* every poll loop had already exited. The gate measured
its exclusion window backwards from the wrong clock. Full derivation in the
23:41 run's section below; the fix and its regression tests are in
`tests/load/lib/command-ledger.mjs` and
`tests/unit/load-harness-accounting.test.ts`. Re-scoring that run with the
corrected accounting gives **0 lost, 2576 of 2578 commands judged, 2 excluded as
untestable**.

**One open item:**

1. **Gate C, at 2829 ms against a hard 2000 ms.** Closest it has ever been, still
   unmet, and the spec calls it non-negotiable. Three levers remain, cheapest
   and safest first:

   **a. Memoise `locals.auth()` per request.** `@auth/sveltekit` assigns a bare
   function, not a memoised promise, so every call re-runs the `jwt` callback
   and its `users` read. The campaign path calls it twice — once in the rate
   limiter, once in `ensureUser` — so one D1 round trip per request is spent
   re-deriving a value that cannot change within a request. This is **not**
   reduction D: it is request-scoped memoisation of an already-computed result,
   not an authorization cache with a TTL, so it carries none of D's staleness
   risk. It applies to 100% of campaign requests including every no-op poll, and
   is the single cheapest remaining win. Found by code review 2026-07-29.

   **b. Reduction D** — the only lever on the ~80% of polls answered from the
   cursor hint, and the only one touching authorization. Needs its own design
   and review.

   **c. Move the data closer** (D1 read replication / Sessions API) — a separate
   decision with consistency trade-offs, out of scope for this document.

   Start with (a): it is the cheapest, carries no staleness risk, and the
   correctness question that previously blocked it is now closed.

**Do not re-derive from wall-clock alone.** A GitHub runner's colo is not
selectable and has varied across `IAD`, `SJC` and `SEA` — 78 to 129 ms per round
trip against the same `MIA` primary. Round-trip counts are stable and are the
comparable figure; wall-clock is not.

**Rollout is still blocked independently of all of this** by the inert rate
limiter — see "Blocking issue at time of writing" at the end of this document.
A green capacity run would not clear campaigns for release on its own.

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

**Every authenticated campaign request pays four round trips before any route
logic runs:**

| # | Where | Query |
| --- | --- | --- |
| 1 | `safeUserId` in the rate-limit handle (`rate-limit/campaign.ts:212`) → `locals.auth()` → `jwt` callback | `SELECT … FROM users WHERE id = ?` |
| 2 | `ensureUser` → `getUserId` → `locals.auth()` again → `jwt` callback **a second time** | the same `SELECT` |
| 3 | `ensureUser` itself (`auth.ts`) | `SELECT id FROM users WHERE id = ?` |
| 4 | `resolveCampaignAccess` (`campaign/access.ts`) | `campaigns` ⨝ `campaign_members` |

That is **the same `users` row read three times** in one request.

> **Corrected 2026-07-29 after code review.** This table previously said three
> round trips and attributed only one to the `jwt` callback. `@auth/sveltekit`
> assigns `event.locals.auth ??= () => auth(event, _config)` — a bare function,
> **not a memoised promise** (`@auth/sveltekit/dist/index.js:337`), so every
> `locals.auth()` call re-decodes the token and re-runs the `jwt` callback,
> including its `users` read. The campaign path calls it twice: once in the rate
> limiter, once in `ensureUser`.
>
> The *measurements* were never wrong — a poll's p50 of 6 round trips is
> 4 auth + 2 route, and 5 after this work removed row 3. Only the attribution
> was. See "Remaining opportunity: memoise the session per request".

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

### Round-trip reduction applied — 2026-07-28, 60s smoke at pilot concurrency

Reductions A, B, C and E from the table above were implemented. D was
deliberately left out: it is the only one that touches authorization.

Measured against a real D1 binding by
`tests/integration/round-trip-budget-d1.test.ts`, which asserts exact counts:

| Path | Before | After |
| --- | --- | --- |
| `ensureUser` | 1 | **0** |
| `loadSessionForReduce` | 5 | **2** |
| `loadTableProjectionsForActor` | 10 | **7** (6 with a caller-supplied cursor) |
| `executeCommand`, accepted | 16 | **7** |

Observed end to end, 60s at 9 campaigns:

| | 17:49 gate (`IAD`) | after (`SJC`) |
| --- | --- | --- |
| Command D1 round trips | 20.00 | **10.00** |
| Poll D1 round trips (mean / p95) | 8.68 / 18 | **6.35 / 13** |
| Command p95 | 2090.9 ms **FAIL** | **1586.8 ms PASS** |
| Poll p95 | 1556.4 ms FAIL | 1786.7 ms FAIL |
| ms per round trip | 78–80 | **122–129** |

#### The colo lottery is now the dominant confound

This run was served by `SJC`; the 17:49 run by `IAD`. Both talk to the same
`MIA` primary, and the per-round-trip cost rose 54–65% purely from that. The
round-trip reduction is real and exactly as budgeted, but the wall-clock
comparison between these two runs is **not** like-for-like.

Normalising to the earlier run's 78.4 ms/round trip, a command's D1 time would
be `10 × 78.4 ≈ 784 ms`, against 1568 ms before — a 50% reduction. At `SJC`'s
129.3 ms it is 1293 ms, which is why the observed improvement is only 18%.

**A GitHub runner's colo is not selectable and varies between runs.** Any future
comparison must quote round-trip counts, which are stable, alongside wall-clock,
which is not. This makes the open question below more pressing, not less.

The "1 lost command" is the grace-window artifact already described for the
00:26 run — 81/81 accepted, 0 duplicates, and a 60s window leaves little room
for the tail. It is not evidence of data loss.

#### Both remaining poll-path duplicates taken — 60s smoke, `SEA`

The two reductions held back above were then applied: the duplicated
`play_sessions` read, and the three slices each issuing the same
tenure/characters join. `loadTableProjectionsForActor` went **7 → 4** round
trips, or **3** when `/sync` hands over the cursor it already holds — down from
10 before any of this work.

| | 17:49 gate (`IAD`) | A/B/C/E (`SJC`) | + both dedupes (`SEA`) |
| --- | --- | --- | --- |
| Command round trips | 20.00 | 10.00 | **10.00** |
| Poll round trips (mean / p95) | 8.68 / 18 | 6.35 / 13 | **5.84 / 10** |
| Command p95 | 2090.9 **FAIL** | 1586.8 PASS | **1499.8 PASS** |
| Poll p95 | 1556.4 **FAIL** | 1786.7 **FAIL** | **1199.7 PASS** |
| Max visible-change | 8260 **FAIL** | 3112 **FAIL** | **2477 FAIL** |
| ms per round trip | 78–80 | 122–129 | 108–120 |

**Poll p95 passed by 0.3 ms.** That is not a margin, it is a coin flip: the same
code on the same path would fail a rerun that landed a few milliseconds slower.
Treat the poll gate as unproven, not met.

Three colos have now served three runs — `IAD`, `SJC`, `SEA` — spanning 78–129 ms
per round trip against the same `MIA` primary. This run drew the second-worst of
them, so the round-trip counts are the durable result and the wall-clock figures
are not.

### 30-minute gate after the reductions — 2026-07-28, 23:41–00:11 UTC: **FAILED (3 of 5 pass)**

Nine campaigns, 27 clients, 1800s, colo `SJC`, D1 primary `MIA`. 31 713
requests, zero errors.

| Gate | Threshold | 17:49 (`IAD`) | This run (`SJC`) |
| --- | --- | --- | --- |
| Max visible-change latency | ≤ 2000 ms | 8260 **FAIL** | 2829 **FAIL** |
| Poll p95 | ≤ 1200 ms | 1556.4 **FAIL** | **1186.9 PASS** |
| Command p95 | ≤ 2000 ms | 2090.9 **FAIL** | **1535.1 PASS** |
| Error rate | < 0.1% | 0.0000% PASS | 0.0000% PASS |
| Lost / duplicated command | zero | 0 / 0 PASS | **2 lost / 0 dup FAIL** |

| Metric | 17:49 (`IAD`) | This run (`SJC`) |
| --- | --- | --- |
| Command D1 round trips | 20.00 | **10.00** |
| Poll D1 round trips (mean / p95) | 8.68 / 18 | **5.88 / 10** |
| Poll latency p50 | 605.1 → 428.7 | **462.8** |
| Command latency p50 | 1591.3 | **1246.1** |
| Visible-change p50 / p95 / p99 / max | 1225 / 1983 / 2312 / 8260 | 1332 / 2054 / 2294 / **2829** |
| Observations > 2000 ms | 226 (4.6%) | 373 (7.2%) |
| Polls / commands completed | 28 200 / 2442 | **29 135 / 2578** |
| ms per round trip | 78–80 | **114–124** |

#### The result is better than it looks, because the geography is worse

This run drew `SJC` at 114–124 ms per round trip; the 17:49 baseline drew `IAD`
at 78–80 ms. Despite paying ~50% more per round trip, this run completed **more**
work (29 135 polls vs 28 200, 2578 commands vs 2442) and passed two gates the
baseline failed. Normalised to `IAD`'s rate, a command's D1 time would be
`10 × 78.4 ≈ 784 ms` against 1568 ms at the baseline.

The tail collapsed: **max visible-change went 8260 ms → 2829 ms**, a 3× tightening,
and p99 went 2312 → 2294 despite the worse path. The slight rise in the >2000 ms
count (4.6% → 7.2%) is the median shifting up with the per-round-trip cost, not
the tail worsening.

**Poll p95 passed by 13 ms.** Better than the 60-second run's 0.3 ms, still not a
margin to rely on, and it would not survive a colo draw as slow as `SJC` was in
the earlier smoke (129 ms/round trip).

#### The 2 lost commands — RESOLVED 2026-07-29, a harness miscount

**No data was lost. The gate was measuring its own exclusion window from the
wrong clock.** Diagnosed from the retained GitHub Actions log for this run
(`gh run view 30408766192 --log`), so the planned instrument-and-re-run was
never needed.

The log's own arithmetic pointed straight at it:

- 2578 commands accepted, **5152 visibility observations**. Two observers per
  command means 5156 expected — exactly **4 missing = 2 commands × both
  observers**.
- Per campaign, `player-a` and `player-b` counts are **identical in all nine
  campaigns**. Not one instance of one player seeing a change the other missed.
  Independent per-client flakiness cannot produce that; both observers went
  missing together.
- The largest gap anywhere in either player's 30-minute observation timeline is
  **8289 ms against a 6660 ms median**. A skipped command would leave a ~13 s
  gap. There is none, in any campaign — so the missing pair is not mid-run.

That places both at the window boundary, and the timings confirm it exactly:

| Clock | Value |
| --- | --- |
| `endTime` — poll loops stop issuing | 00:11:56.749 |
| `windowEndedAt` — last async task settles | 00:12:01.588 (**+4839 ms**) |
| grace (`pollInterval + jitter + worst propagation`) | 3979 ms |
| cutoff (`windowEndedAt − grace`) | 00:11:57.609 — **860 ms after polling stopped** |

`windowEndedAt` is stamped after `Promise.all` resolves. A command loop only
re-checks the clock *after* `sleep(commandIntervalMs)`, so one that entered its
5000 ms sleep just before `endTime` keeps `Promise.all` pending for nearly 5 s
past the moment every poll loop exited. Measuring the grace backwards from that
straggler put the cutoff **after observation had already ceased**, opening an
~860 ms dead band in which an accepted command is eligible to be judged and yet
has no client alive to observe it.

Reconstructing each campaign's final command from its last observed one and the
loop cadence predicts, independently of the reported figure, that **exactly two
campaigns — 3 and 4 — issued a further command landing in that dead band**
(accepted 00:11:57.343 and 00:11:56.673). Every other campaign's next command
fell after `endTime` and was never issued at all. Predicted 2, reported 2.
2576 observed + 2 = 2578 accepted. The account closes exactly.

This also retroactively explains the 00:26 run's single "lost" command by the
same mechanism, which is a better explanation than the tail argument recorded
for it at the time.

**The fix** anchors judgement to when observation stopped rather than to when
the last task settled, in `tests/load/lib/command-ledger.mjs` — extracted into
its own typed module precisely because a miscount in a zero-threshold gate reads
exactly like real data loss. `tests/unit/load-harness-accounting.test.ts` pins
the behaviour, including that a genuinely unobserved command which *did* have a
full fair chance still fails the gate. The gate now also reports how many
commands it actually judged, so a run that quietly stops judging most of its
traffic can no longer look like a clean run.

This is a correction to the measurement, **not** a relaxation of the gate: the
threshold is still zero, and every command that had a real opportunity to be
seen is still held to it. Re-scoring this run with the corrected accounting:
**0 lost, 2576 of 2578 judged, 2 excluded as untestable.**

#### Still open

- **Gate C remains unmet** (2829 ms against a hard 2000 ms). It is now the
  closest it has ever been, and it is still the gate the spec calls
  non-negotiable — and now the *only* failing gate.
- **Reduction D is untouched**, and remains the only lever on the 80.4% of polls
  answered from the cursor hint, which still pay 2 round trips of authentication
  and authorization each and nothing else.
- **Poll p95 passes by 13 ms**, which is inside the run-to-run colo variance
  already observed. Treat it as met-on-this-path, not met.
- **A future run judges ~8 fewer commands than it accepts.** With the cutoff
  correctly anchored, commands accepted within one grace period of `endTime` are
  excluded rather than miscounted. If that exclusion ever needs to shrink, the
  fix is to let the poll loops drain for one grace period after the command
  loops stop — not to move the cutoff back.

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
