# Campaign rollback runbook (Increment 5 Task 5)

**Read this before an incident, not during one.**

The rollback for campaigns is a **configuration change, and only a
configuration change**. Campaigns, sessions, commands and their event history
are ordinary D1 rows. Turning the feature off removes HTTP reachability and
nothing else, so a rollback is always **forward-only**: you re-deploy with a
different flag, you never undo a migration and you never delete data.

If you take one thing from this page: **freeze first, flip second, delete
never.**

---

## 1. Who can do this

| Action | Who | How |
| --- | --- | --- |
| Flip `CAMPAIGNS_ENABLED` / edit `CAMPAIGNS_PILOT_USER_IDS` | anyone with Cloudflare deploy access to the `guild-book` Worker — today that is the repository owner alone | `npx wrangler deploy` from a checkout, or the Cloudflare dashboard (see §3) |
| Freeze or end one session | the campaign's **GM**, from the table UI; or an operator with the GM's cookie / D1 access | `campaign-pilot.md` §3 |
| Read aggregate health | anyone holding `CAMPAIGN_HEALTH_SECRET` | `GET /api/internal/campaign-health` |
| Query D1 directly | anyone with Cloudflare D1 access | `npx wrangler d1 execute` |

There is no in-product admin control for the feature flag, deliberately. It is
a deployment variable, so flipping it is an auditable deploy rather than a
button someone can reach with a stolen session cookie.

**Access is currently one person deep.** That is a real single point of failure
for an out-of-hours incident and it is a known gap, not an oversight — record it
as such rather than discovering it at 2am.

---

## 2. Decide the scope first

Three scopes, smallest first. Prefer the smallest one that actually contains the
problem.

| Situation | Scope | Lever |
| --- | --- | --- |
| One table has gone wrong | **that session** | GM clicks **Freeze table** (§4) |
| One participant is the problem | **that person** | remove their id from `CAMPAIGNS_PILOT_USER_IDS`, redeploy |
| Something is systemically wrong — a privacy failure, a correctness bug, a capacity collapse | **the whole feature** | `CAMPAIGNS_ENABLED=false`, empty allowlist, redeploy (§3) |

A feature-wide flip is not the fast option. Freezing a single session takes one
click and stops play immediately; a flip takes a build and a deploy. **If the
problem is one table, freeze that table.**

---

## 3. The feature-wide flip

### What to change

```toml
# wrangler.toml — [vars] for production, [env.staging.vars] for staging
CAMPAIGNS_ENABLED = "false"     # or delete the line; absent reads as off
CAMPAIGNS_PILOT_USER_IDS = ""   # empty, or the operator's id alone for recovery
```

Then:

```bash
ADAPTER=cloudflare npm run build
npx wrangler deploy                    # production
npx wrangler deploy --env staging      # staging
```

`canAccessCampaignFeature` (`src/lib/server/campaign/config.ts`) grants access
when **either** the flag is on **or** the user's id is in the allowlist, so
"off for everyone except me" is `CAMPAIGNS_ENABLED=false` plus your own id in
`CAMPAIGNS_PILOT_USER_IDS`. That combination is what you want during recovery:
it lets you reach a stranded session without readmitting the public.

### How long it takes — and why you must not trust a number

The build is a few seconds and `wrangler deploy` returns in under ten. **Neither
of those is when the rollback takes effect.**

Rehearsal on 2026-07-29 established three things that matter more than any
single timing:

1. **The old configuration keeps being served after the deploy returns.** A
   non-allowlisted player retained full access for **8 seconds** after a deploy
   that should have locked them out. First-observation timings ranged from
   332 ms to **70 seconds** across runs of the identical operation — a 200×
   spread, so there is no "expected" number to plan against.
2. **A stale isolate can survive more than one deploy.** During the rehearsal a
   player briefly received a `200` that *neither* the current configuration
   *nor* the previous one permitted — only the fully-enabled configuration from
   **two deploys earlier** did. Deploying twice in quick succession does not
   shorten the window; it layers a second one on top.
3. **`/api/internal/campaign-health` can disagree with the live routes.** It
   reported `campaignsEnabled: true` for 18 seconds while the campaign routes
   were already enforcing `false`. Health is a useful signal and a **bad
   confirmation**.

Measured on staging, 2026-07-29 (§9). "Settled" is the point from which every
checked signal had agreed continuously for 15 seconds:

| Transition | `wrangler deploy` | First full agreement | Settled |
| --- | --- | --- | --- |
| Campaigns → off, no allowlist | 8.1 s | 31.8 s | **47.3 s** |
| Off → operator allowlisted | 6.9 s | 50.6 s | **66.6 s** |
| Campaigns → on again | 7.5 s | 27.8 s | **43.2 s** |

**Plan for a minute, not a moment.** On the disable, campaigns remained
reachable through at least one route for **30.4 seconds** after the deploy
command returned successfully.

**The endpoints do not flip together.** On that same disable, `/sync` was
already refusing at 332 ms while `/api/campaigns` was still admitting and health
still reported the feature enabled. A rollback is *partial* for roughly half a
minute, and which half you happen to probe decides what you conclude.

### Confirming the rollback actually landed

Do not announce containment on one probe, on health alone, or on the deploy
exiting cleanly. Confirm it the way the rehearsal harness does:

1. **Check from the perspective that matters** — a user who must now be
   refused, not an operator who is still allowed. An operator's `200` looks the
   same whether the allowlist landed or campaigns never went off at all. That
   ambiguity is exactly what leaked a player through in rehearsal.
2. **Check several things at once and require them to agree** — at least one
   account that must be refused, one that must be allowed (if any), and health's
   view of the flag. A mixed edge shows up as disagreement between them.
3. **Require the agreement to hold**, not merely to occur. The harness demands
   15 continuous seconds before it will call a flip settled.
4. **Make one change at a time.** If you need "off for everyone, then back on
   for me", treat those as two separate, separately-confirmed steps. Chaining
   them is what produced the two-deploys-stale leak.

`scripts/campaigns/rollback-rehearsal.mjs` does all four and prints the settle
time and the mixed window. In an incident, the same shape by hand:

```bash
# Repeat until the answers agree and STAY agreed for ~15s.
# $VICTIM_COOKIE = an account that must now be refused.
watch -n1 'curl -s -o /dev/null -w "refused-user:%{http_code} " \
    -b "$VICTIM_COOKIE" https://guildbook.arrowed.games/api/campaigns; \
  curl -s -H "Authorization: Bearer $CAMPAIGN_HEALTH_SECRET" \
    https://guildbook.arrowed.games/api/internal/campaign-health \
    | grep -o "\"campaignsEnabled\":[a-z]*"'
```

A `404` for the refused user is the authoritative signal. Health agreeing is
corroboration, not proof.

### The dashboard shortcut, and why it is a trap

Cloudflare's dashboard can edit a Worker's plaintext variables directly, with no
build and no deploy. It is genuinely faster and it is the right lever if the
build is broken or you are away from a checkout.

**But `[vars]` is replaced wholesale on every deploy.** A value set in the
dashboard and not also written into `wrangler.toml` disappears the next time
anyone runs `wrangler deploy` — including a routine, unrelated deploy by someone
who does not know an incident is in progress. If you use the dashboard, **write
the same change into `wrangler.toml` and commit it before you do anything
else**, or you have set a timer on your own rollback.

### What a flip does not do

- It does **not** end or freeze open sessions. They stop being reachable and
  stay exactly where they were; re-enabling resumes them mid-session.
- It does **not** sign anyone out, touch characters, rules, denizens, the deck,
  or public share links. Those are outside the campaign feature and the
  rehearsal verifies they keep serving (§9).
- It does **not** require a migration, in either direction.

---

## 4. Finding and freezing affected sessions

Aggregate first, identifiers only when you need to act on a specific table.

**Aggregate — the health endpoint.** Returns counts, never ids:

```bash
curl -H "Authorization: Bearer $CAMPAIGN_HEALTH_SECRET" \
  https://guildbook.arrowed.games/api/internal/campaign-health
```

It reports `campaignsEnabled`, `pilotAllowlistSize` (the size, never the ids),
rate-limit binding presence and enforcement, D1 reachability, migrations
applied, the content digest, and `activeSessions` / `frozenSessions` /
`oldestFrozenAgeSeconds`. This is the first thing to read and the safest thing
to paste into an incident channel.

**Identifiers — D1, in secure operator tooling only.** These queries return
session and campaign ids. Run them in your own terminal against your own
Cloudflare account; do not paste their output anywhere shared.

```bash
# Every open session, oldest first
npx wrangler d1 execute guild-book-db --remote --command \
  "SELECT id, campaign_id, status, version, started_at
     FROM play_sessions
    WHERE status IN ('active','frozen')
    ORDER BY started_at"

# One campaign's session history
npx wrangler d1 execute guild-book-db --remote --command \
  "SELECT id, sequence, status, version, started_at, ended_at
     FROM play_sessions WHERE campaign_id = '<campaign-id>' ORDER BY sequence"
```

**Freezing.** The GM's **Freeze table** button is the normal path. When the GM
is unreachable, or the UI is the broken thing, an operator with the GM's session
drives the same transition directly:

```bash
curl -X PATCH "$BASE/api/campaigns/$CAMPAIGN_ID/sessions/$SESSION_ID" \
  -H "Content-Type: application/json" -H "Origin: $BASE" \
  -b "$GM_COOKIES" -d '{"action":"freeze"}'
```

Omit `expectedVersion` when you need the freeze to land regardless of concurrent
activity — that is the incident case. Supply it only when you specifically want
the freeze to no-op if the session moved first. Full reference, including
recover and end: `campaign-pilot.md` §3.

**Never freeze by writing `play_sessions.status` in SQL.** The lifecycle path
claims a version and stamps fragment versions in the same atomic commit
(`src/lib/server/session/lifecycle.ts`); a bare `UPDATE` skips that and leaves a
session whose fragments disagree with its version — which is the corruption the
freeze exists to contain.

---

## 5. Evidence that is safe to collect

Collect the aggregate freely. Treat everything else as needing a reason.

**Safe to share, including in a group channel:**

- the full `/api/internal/campaign-health` response;
- counts, durations, status codes, rejection codes, retry counts;
- the metric names in `src/lib/server/observability/campaign-metrics.ts` and
  their values, including the `{"metric":…}` lines the sink emits — that
  allowlist exists precisely so operational signal can be shared without
  review, and it is enforced: the name is checked against a closed set, and
  tags are matched against known enums with no free-text field;
- deployment version ids, migration counts, the content digest.

**Operator-only — your terminal, an encrypted note, an incident ticket with
restricted visibility:**

- campaign, session, user and membership ids;
- rows from `play_sessions`, `session_commands`, `campaign_members`;
- **raw `wrangler tail` output.** An earlier draft of this runbook listed it as
  safe to share and said the session layer had "exactly two log call sites".
  Both claims were wrong, and the 0.7.0 pre-release review caught them. There
  are ten sites under `src/lib/server/session/`;
  `table-projections.ts:156` logs a **session id** in plain text — which this
  very list classifies as operator-only — and most of the rest log the caught
  exception object, whose message comes from the database driver and can carry
  statement fragments. What remains true is the narrower claim the privacy
  canary suite actually enforces: no card identity and no private payload is
  ever logged. Read the tail yourself, quote the line you need, and do not
  paste the stream.

**Never collect, never paste, never screenshot:**

- invite tokens or share tokens — they are credentials, and anyone holding one
  can use it;
- `AUTH_SECRET`, `CAMPAIGN_INVITE_SECRET`, `CAMPAIGN_HEALTH_SECRET`, or any
  session cookie;
- `session_server_states.server_state_json`, `session_private_states.private_state_json`,
  `campaign_event_secrets` rows, or any card identity from a hidden zone;
- raw character JSON.

If a privacy incident is what you are investigating, the thing you must not do
is make a second copy of the leaked data while writing it up. Describe the shape
of the leak — which role saw which zone — not its contents.

---

## 6. Things that are never a rollback

**Do not** do any of the following in response to a campaign incident. None of
them are reversible, and none of them are necessary — the flag alone stops
everything a rollback needs to stop.

- **Do not drop or truncate any table.** Not `play_sessions`, not
  `session_commands`, not `campaign_events`, not `campaigns`.
- **Do not delete the command journal.** `session_commands` is what makes a
  command idempotent by id and what proves, after the fact, whether a command
  was accepted once or twice. Deleting it destroys the only record that can
  answer the question the incident is about.
- **Do not delete session secrets or private state** to "clean up" a leak. The
  end-session path sanitizes them correctly and atomically; a manual delete
  leaves referencing rows behind and destroys the evidence.
- **Do not roll a migration back.** Migrations here are forward-only. A schema
  change that has to be undone is undone by a new migration, reviewed and
  applied like any other.
- **Do not rotate `CAMPAIGN_INVITE_SECRET` as a first response.** It invalidates
  every outstanding invite for every campaign, which is a much wider blast
  radius than most incidents. Close or rotate the affected campaign's invite
  instead.
- **Do not restore from backup** to undo a campaign incident. Restore is for
  data loss (`docs/operations/backup-restore.md`) and would discard every
  unrelated change since the snapshot.

`npx wrangler rollback <version-id>` reverts **code**, not variables. It is the
right tool for "the deploy itself broke the site" and the wrong one for "the
campaign feature is misbehaving" — for that, flip the flag, which leaves the
rest of the site on the current build.

---

## 7. Escalation

| Signal | Response |
| --- | --- |
| A single table is stuck or behaving oddly | GM freezes; investigate; recover or end. No flip. |
| A card identity or private zone reached the wrong role | Freeze immediately, **do not end** (ending sanitizes the evidence), then `campaign-pilot.md` §5 — this is a correctness failure in the guarantee the feature is built on and gets a written incident record. |
| Two or more unrelated tables report the same fault | Flip the feature off, keep your own id allowlisted, investigate with real sessions still intact. |
| D1 unreachable, or error rate above the 0.1% gate | Flip off. This is capacity or infrastructure, not a table problem, and leaving it up produces more damaged sessions. |
| Suspected abuse or a runaway client | Check `rateLimit.enforcement` in health first. `enforcing` means the edge limiter is doing its job and the flag is a second lever, not the only one. Anything else means no edge limiting, and the allowlist or the flag is all you have — see §8. |
| Anything you cannot explain within ~15 minutes | Flip off. The feature is not load-bearing for the rest of the site and a stopped table loses nothing. |

---

## 8. Known gaps this runbook cannot paper over

1. **The rate-limit binding enforces — but verify production before relying on
   it.** From 2026-07-27 this was recorded as a hard blocker: the bindings
   deployed and resolved but appeared never to count. The 0.7.0 pre-release
   review found the fault was in our own self-test, which overshot the limit by
   a single call and so sat inside Cloudflare's documented permissiveness.
   Widening the margin flipped staging to `enforcing` on 10 of 11 probes.
   **Staging is verified; production is not** — it has its own namespaces and
   its own health secret, so run the same check there before treating edge
   limiting as available during an incident. See `DEPLOY.md`.
2. **Rate limits are per Cloudflare location even when they do work.** A client
   distributed across N colos gets roughly N× the nominal limit. The Durable
   Object upgrade trigger is written down in `campaign-capacity.md`.
3. **Deploy access is one person.** See §1.
4. **Structural preconditions are advisory under real concurrency** (issue #14):
   a structural command can be applied against a version it declared it was not
   expecting, at 3–5% of contended rounds on D1. If an incident report reads
   "the table advanced twice" or "the procedure moved from a step nobody was
   on", that is the likely cause, and freezing preserves the
   `session_commands` rows that prove it.

---

## 9. The rehearsal

Rehearsed against staging on **2026-07-29**, driven by
`scripts/campaigns/rollback-rehearsal.mjs`. **47 of 47 checks passed.** Fixture
prefix `rollback-ms6ygbfy`; its campaign was ended and archived at the end, and
staging finished on `campaignsEnabled=true` with an empty allowlist, zero frozen
sessions, migrations `10 → 10` and an unchanged content digest.

What the rehearsal established, beyond the timings in §3:

- **The rollback is genuinely non-destructive.** Migrations unchanged, content
  digest unchanged, and the session that was open across the whole cycle was
  recovered, ended with a public-history checksum, and read back afterwards by
  an ordinary player. Nothing had to be migrated back.
- **The boundary holds in both directions.** With campaigns off, ten campaign
  routes returned `404` for GM and players alike — including a session command
  and an invite join, so mutations are refused rather than merely hidden — while
  `/`, `/characters`, `/rules`, `/denizens`, `/deck`, `/login`, `/licensing`,
  `/api/characters` and `/api/denizens` all kept serving.
- **Operator-only access really is operator-only.** Under `CAMPAIGNS_ENABLED=false`
  with a single allowlisted id, the operator could read, freeze, recover and end
  the session while both players stayed at `404`.
- **Archiving stayed blocked while the session was open** (`409`), and released
  once it had ended.
- **A `--var` override deploy preserves the environment's other variables** —
  verified by `Server-Timing` still being emitted, which only happens when
  `CAMPAIGN_TIMING_HEADER` survives.

Two honest caveats about this run, **both closed by the 2026-07-30 re-run**
(48/48 checks passed; same procedure, same script):

1. **The public-share check did not execute.** The harness creates its fixture
   adventurer as a draft, and drafts cannot be shared by design
   (`share.ts:37` → `409`), so the check reported itself skipped rather than
   faking a pass. The harness now finalizes the adventurer first; in the
   re-run a real share link was minted before the flip and **resolved with
   `200` while campaigns were off** — the check has now genuinely executed.
2. **The rate-limit binding reported `not-enforcing`** at the time of this
   rehearsal (§8). That verdict was traced to a bug in the self-test rather
   than the provider; the re-run's preflight reported `enforcing`.

The re-run also reconfirmed the propagation spread that makes §3 a procedure
rather than a number: settled times of 17.1 s, 68.3 s and 83.7 s across its
three flips, with first-agreement as low as 1.8 s — the same 10×-plus
variance, in one run.

Earlier runs the same day failed and are worth knowing about, because both
failures were in the *measurement*, not the product: a first-observation
propagation probe declared the flip complete at 380 ms and let the rehearsal act
during the mixed window, and a probe watching only the operator could not
distinguish "the allowlist landed" from "campaigns never went off". The second
of those briefly showed a player with access that no then-current configuration
permitted — the two-deploys-stale case in §3.

Re-run it with:

```bash
CAMPAIGN_STAGING_AUTH_SECRET=<staging AUTH_SECRET> \
CAMPAIGN_HEALTH_SECRET=<staging CAMPAIGN_HEALTH_SECRET> \
  node scripts/campaigns/rollback-rehearsal.mjs
```

The script refuses the production hostname and any wrangler environment not
named `staging`, and restores staging's flag on every exit path including
Ctrl-C. It builds once and then redeploys the same artifact with different
`--var` values, so the only thing changing between measurements is the flag.
