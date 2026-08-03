# Changelog

All notable changes to Guild Book will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [Unreleased]

### Changed

- The Challenge browser test now records which seat performed each turn — via
  a new inert `data-turn-seat` attribute on the turn controls — and fails if
  the GM's oversight override silently substitutes for a stalled player
  client, instead of passing without ever exercising the player path (#26).

## [0.15.0] - 2026-08-02

### Added

- Challenge controls now report when they are processing an action to assistive
  technology, without delaying the Challenge's live turn announcements.

## [0.14.0] - 2026-08-02

### Added

- Adventurers can now take more than one of the same item, both at the Omphalic
  Market during creation and on the character sheet afterwards. Each copy spends
  one of your market picks, so two daggers cost two of your five common items.
  Stackable gear arrives a stack at a time — choosing arrows gets you a quiver
  of twelve, which is what the rules give you and what a slot holds — while the
  character sheet spends it one arrow at a time, the way a session does. Going
  over your belt or backpack still only warns you; it never stops you choosing.

### Fixed

- A second suit of armor no longer travels for free. Only one suit is worn and
  billed against the belt; the spares are carried in the backpack, where they
  take up the room they should.
- An adventurer left half-finished in the Omphalic Market before this release
  kept a single arrow where a quiver was meant to be. Reopening that adventurer
  now restores the full quiver instead of losing the arrows on the next change.

## [0.13.0] - 2026-08-02

### Changed

- CI no longer re-runs the full suite on every push to `main`. The branch
  ruleset already requires `check` and `e2e` to pass on the exact merge result
  and allows no bypass, so the post-merge run was a redundant gate on a
  byte-identical tree rather than an independent one. A nightly run on `main`
  replaces it, and is better positioned to surface drift in the runner image or
  browser build underneath a lockfile-pinned tree.
- A pull request's in-flight CI run is now superseded when the branch is pushed
  again, instead of running to completion against a stale commit. The release
  path is excluded from this, though `release.yml`'s own `production-release`
  group can still drop a queued release when tags are pushed close together.
- `npm run release:verify` no longer runs the browser suite. CI runs it on the
  release pull request and again on the tagged commit, so the local repeat only
  added minutes to a release without asking a new question.
  `content:verify` and the `origin/main` content comparison stay local, because
  they need the gitignored Markdown vault and the pre-merge vantage point.

## [0.12.0] - 2026-08-02

### Added

- Every rules page now ends with a card thanking Josh McCrowell for the open
  license that makes the reference possible, linking to the license itself and
  to where His Majesty the Worm can be bought.

### Changed

- The project now spells "license" the way the author does on his own site,
  rather than using the British "licence", in the licensing page, the READMEs,
  the contributing and deploy guides, and other documentation. The content
  pack's own metadata (`static/content-packs/hmtw/index.json`) is unchanged —
  it is covered by a tamper-evidence digest, and a cosmetic spelling edit
  there is not worth the pack version bump regenerating that digest would
  force.

## [0.11.0] - 2026-08-01

### Added

- Tarot card artwork: drawn cards now render the full, uncropped Rider–Waite–Smith
  illustration in an archival frame with a label footer, and an enlarge control
  opens the card at full size. Face-down cards show an "Adherent of the Worm"
  back, composed at build time in two treatments and paired for contrast with
  the active theme.
- A deterministic artwork build pipeline (`npm run tarot-art:build`) emitting
  responsive 240/480/960 AVIF and WebP derivatives with a hash manifest, and a
  verifier (`npm run tarot-art:verify`) that checks the committed derivatives
  against that manifest. The verifier runs in CI and in `release:verify`.

### Changed

- A card's face image is resolved only for a viewer already entitled to see it,
  so a hidden card's identity cannot leak through an image request URL. The
  shared-table privacy suite now asserts this at the network level.
- Environments without built artwork keep working: the app detects the absent
  manifest and falls back to the previous glyph rendering.
- Internal tidying from the #15 and #16 reviews: the admin page's server load no
  longer returns a page-size field nothing reads, and the 320px zoom check
  documents why polling `scrollWidth` is sound there.

### Fixed

- A structural command can no longer apply to a session version its actor
  declared it was not expecting (#14). The declared precondition was checked
  against one read of the session but the version claim was built from a later
  one, so a second command committing between the two could slip through
  unnoticed — at a shared table this showed up as the round advancing twice
  when only one GM had asked for it. The precondition is now re-checked against
  the read that feeds the claim, and the claim builder refuses outright to
  write a row whose precondition and target version disagree.

## [0.10.0] - 2026-08-01

### Added

- Full rules coverage: every section of His Majesty the Worm chapters 1–9 is
  now in the rules reference — including worked examples, sidebars, and
  epigraphs — reproduced with the creator's permission (content pack 4.0.0).
- Site-wide rules search: a fuzzy, ranked search box in the header of every
  page, with keyboard navigation (`/` to focus) and deep links into the
  reference; the `/rules` index gains a ranked full-text results mode.
- Phrase-aware search: a query that occurs verbatim in the rules (quoted or
  not — double quotes are tolerated, never required) outranks scattered-word
  matches, the result snippet shows the phrase itself, and clicking the
  result scrolls to the phrase highlighted in place within the article.

### Changed

- Rule entries' tags are now optional metadata; chapter-walked entries carry
  none by default, and rule articles no longer display the legacy curated tag
  chips.
- Rulebook tables render with grid lines and centered cells.

## [0.9.1] - 2026-07-31

### Fixed

- `/sync` now echoes the authenticated recipient in an `X-Guildbook-Recipient`
  response header, and the table store scrubs the previous user's projection
  when a 204 carries a foreign value — closing the last account-switch surface
  where a still-current cursor let a bodyless 204 keep the prior user's private
  card faces rendered (#25, residual of #22).

## [0.9.0] - 2026-07-31

### Added

- **Production releases are now exact-tag gated through GitHub Actions.** A
  `vX.Y.Z` tag must match `package.json` and a dated changelog heading, then the
  tagged commit must pass content verification, type checking, unit/integration
  tests, Cloudflare builds and dry-runs, and the deterministic browser suite
  before a protected `production` environment may deploy it with Wrangler.
  Release tags must be annotated, and a pre-tag `--require-new` validation
  refuses a tag that already exists or is lower than the newest existing
  release, failing closed when tag history cannot be read.
- **Browser failures now retain actionable evidence.** CI uses bounded
  concurrency, treats retry-only passes as failures, and uploads Playwright
  traces, screenshots, reports, and combined browser/server output. A separate
  scheduled or manual stress profile exercises campaign concurrency without
  authorizing a release.
- **Release-critical client state has direct regression coverage.** Campaign
  polling covers lifecycle scheduling, cancellation, sanitization,
  deduplication, and every command projection path. The adventurer wizard has a
  complete save-and-resume flow plus invalid-state, migration, reset, and
  storage coverage.

### Changed

- **Campaign sync responses are bound to their authenticated recipient.** Each
  changed sync response carries a request ID and recipient ID; unchanged 204
  responses carry the request ID. Command and lifecycle responses that can
  replace a projection are recipient-bound as well. The browser discards an
  entire payload addressed to another user and scrubs the previously rendered
  actor-scoped state (see Fixed below). Privacy specifications attach
  cursor/version/request metadata without card faces, private payloads,
  cookies, or credentials.

### Fixed

- **A signed-in user change can no longer leave the previous user's table
  state rendered** (issue #22). The campaign table rebuilds its session store
  when the authenticated user changes, and any sync or command response
  addressed to a different user — or a sync refusal (401/403/404) signalling
  the viewer lost access — scrubs the previous user's actor-scoped projection,
  private card faces included, and halts polling instead of retaining it.
  Transient server errors without any recipient keep the current state.
- **Challenge browser-test helpers wait the full 15 s convention.** The
  fixture's internal 4–6 s stage and acting-page budgets matched the rest of
  the suite's raised waits, so slow CI polling can no longer let the GM's
  oversight override silently substitute for an active player's turn.
- **Wizard persistence keeps real in-progress work.** A non-default talent
  choice now survives a reload before continuing, and an older valid draft is
  written back in its migrated shape once without recreating absent or invalid
  storage.

## [0.8.0] - 2026-07-31

### Changed

- **The two per-poll campaign metrics are now sampled 1-in-10 at the sink**
  (`poll_duration_ms`, `poll_no_change`). Unsampled they cost up to two log
  lines per second per open client — roughly 50 lines/second at pilot scale
  once no-change polls' second line is counted, growing linearly with public
  users. One probabilistic decision is rolled per poll and shared by both of
  that poll's points — hint-answered polls included — so sparse or periodic
  no-change patterns cannot systematically bias the reported ratio and isolate
  restarts do not over-sample first polls. Every emitted line carries `sample: 10` so
  counts can be multiplied back up. Command, rejection, freeze, and recovery
  points remain unsampled — they are low-volume and are what an incident needs.
- **Campaign E2E waits lengthened from 8 s to 15 s** across the session specs'
  8-second inline `waitForResponse`/navigation timeouts and helper defaults
  (shorter 2–6 s waits and the Challenge fixture's internal budgets followed
  after this release).
  Under artificial full-core saturation the dev server genuinely answered
  slower than 8 s in 3 of 40 runs; the longer wait costs nothing on passing
  runs, which resolve as soon as the response arrives (issue #17).

## [0.7.1] - 2026-07-30

### Fixed

- **The admin dashboard's "Next" link now appears only when rows actually
  remain**: it was inferred from the current page being full, so with an exact
  multiple of 50 rows the last page still offered "Next" and led to an empty
  page. The decision now lives in the server load function, computed from the
  real row totals — which the tables provably match, since
  `characters.user_id` is `NOT NULL` behind an enforced foreign key (issue
  #11, PR #15 by @blockbeard).
- **The 320px campaign-table test no longer flakes under machine load**: its
  DOM-order check read two elements it had never waited for, and lost that
  race when cores were saturated. The check now waits for both elements to
  attach before reading them, and the zoom-overflow check polls the read it
  depends on instead of sleeping a fixed 300 ms. Reproduced failing first (8
  of 20 runs under artificial full-core load), then 0 DOM-order failures
  across 40 runs under the same load; a separate rare timeout those runs
  surfaced is tracked as issue #17 (issue #12, PR #16 by @blockbeard).

## [0.7.0] - 2026-07-30

### Changed

- **Deployment target moved from Cloudflare Pages to Cloudflare Workers**
  (roadmap decision D4). No application code changed: `@sveltejs/adapter-cloudflare`
  already emits `_worker.js` alongside the static asset tree, so
  `wrangler.toml` swapped `pages_build_output_dir` for `main` + `[assets]` and
  the build command is untouched. `nodejs_compat` is retained — it is required
  for `node:crypto` and already supplies AsyncLocalStorage, so the adapter's
  suggested `nodejs_als` flag proved unnecessary. `guildbook.arrowed.games` now
  resolves to the Worker; the Pages project is retained, undeleted, as the
  rollback path. Deploys are manual (`wrangler deploy`) until Workers Builds is
  connected — pushing `main` no longer ships production on its own.
- Rotated `AUTH_SECRET` during the cutover, signing out existing sessions as
  `src/lib/server/auth-policy.ts` recommends. Share links are unaffected: they
  resolve a stored `shareId` rather than a signed token.
- **Cloudflare Smart Placement was enabled on staging and reverted the same
  day**, as a measured regression rather than an untested idea. It genuinely
  moved the Worker — Cloudflare's own `cf-placement` header reported `remote-`
  on 84.1% of 36 740 requests — but the per-round-trip D1 cost did not improve
  (63.0/69.5 ms against 62.5/67.9 ms with it off) while wire time roughly
  tripled, so every request paid a new cost and got nothing back. Smart
  Placement decides from a Worker's observed outbound subrequests, and D1 is
  reached through a runtime binding rather than a `fetch()`, so Cloudflare has
  no signal for where the data actually is. `wrangler.toml` retains the full
  reasoning so it is not retried blind.

- **Campaign polling and command latency roughly halved**, by cutting the number
  of sequential D1 round trips each request makes. Instrumentation established
  that latency here is bound by round-trip *count* — the network is 3–6% of a
  request and Worker CPU is nil — and that commands run fully sequentially, so
  every round trip sits on the critical path. Commands went from 20 round trips
  to **9.00** and polls from 8.68 to **4.77 mean**, the last step coming from
  memoising `locals.auth()` per request; the figures are measured, with 100%
  `Server-Timing` coverage across three 30-minute runs, not predicted.
  `ensureUser` no longer re-reads the `users`
  row the Auth.js `jwt` callback already read and existence-checked in the same
  request; an accepted command projects the state it just committed instead of
  re-loading the whole session to build its response (also tighter — a reload
  could observe a later command and report a projection ahead of its own
  `resultingVersion`); the four session fragments that depend only on
  `sessionId` load as one batch; and the campaign cursor, the `play_sessions`
  row and the campaign actor-facts join are each read once per request rather
  than two or three times. Round-trip budgets are now asserted as exact counts
  against a real D1 binding, since nothing else in the suite can see a round
  trip. Four of five capacity gates now pass; the fifth, the 2-second bound on
  how long an accepted change takes to become visible to the rest of the table,
  is 129 ms short and parked as issue #13 — see
  `docs/operations/campaign-capacity.md`.

### Added

- **Server-side request timing**, so the campaign capacity gate can separate
  network time from database time. Both 30-minute gate runs on 2026-07-28
  failed and both ended at "we cannot tell whether it is the network or D1",
  because the deployed Worker never measured its own time — `recordPoll` was
  called but no metric sink was ever installed. Responses now carry
  `Server-Timing: srv;dur=…, d1;dur=…;desc="n=… stmts=…"` plus the serving
  Cloudflare colo, with per-request attribution through `AsyncLocalStorage` (a
  module-level counter would blend an isolate's concurrent requests) and D1
  round trips counted by wrapping the binding in a pass-through `Proxy`. A
  batch is reported as one round trip carrying many statements, because the
  open question is round-trip *count*, not statement count. The load harness
  records the header per request and reports the resulting split, including
  coverage — a run where the header never arrived must not look like a run
  where the server took no time. Off by default and gated behind
  `CAMPAIGN_TIMING_HEADER`, which staging sets and production deliberately does
  not.
- **Campaign rate limiting** behind a provider-neutral port, with a Cloudflare
  rate-limit binding as the production adapter and an injectable-clock
  in-memory limiter as development defence. Four independent policies — session
  commands, campaign mutations, invite joins and session polling — keyed on a
  hash of actor plus campaign, falling back to the client address for
  unauthenticated join attempts, so no raw identifier reaches provider
  analytics. Denials return `Retry-After` without disclosing whether the
  campaign exists. Note the provider's counters are **per Cloudflare location,
  not global**. When the binding is unreachable, mutations fail closed while
  polls are served degraded and counted — polling GETs were previously
  unlimited, so refusing them would be a regression rather than a protection.
- **A rate-limiter self-test** on the health endpoint. A binding can deploy,
  type-check, appear as a Rate Limit resource, and still never count, which is
  indistinguishable from "under the limit" to every other signal. The health
  check now calls a dedicated binding past its own limit and reports
  `rateLimit.enforcement`; anything but `"enforcing"` blocks making campaigns
  public. **This self-test was itself wrong, and finding that out was the
  point of it.** Its first version overshot the limit by one — two calls
  against a 1-per-10s binding — and Cloudflare documents these counters as
  permissive and eventually consistent rather than exact, so a healthy binding
  is allowed to let two through. Zero denials was read as "never counts", and
  a working limiter was reported broken for three days and raised with
  Cloudflare support. Widening the overshoot to `limit + 5` flipped staging to
  `enforcing` on 10 of 11 consecutive probes. Production is not yet verified,
  and the 2026-07-27 throwaway-Worker result (13 allowed against a limit of 5)
  is still unexplained by this.
- **Privacy-safe campaign operations metrics** with a closed metric-name union
  and a fixed tag shape — no `Record<string, unknown>` sink and no free-text
  field, so command bodies, card identities, invite tokens, character payloads
  and ids have nowhere to leak. Command types and procedure phases are
  sanitised against known enums; unrecognised values collapse to a coarse
  label. Points are emitted as one structured JSON line each into the Workers
  log pipeline. **That sink was missing until the 0.7.0 pre-release review**:
  the layer was built, unit-tested and documented, but nothing outside the test
  suite ever installed a sink, so `recordCampaignMetric` returned early and
  every point was dropped in every deployed environment. The tests passed
  because each installed its own. It is now installed once per isolate and
  covered by a test that fails if it ever stops being.
- **An internal health endpoint** at `/api/internal/campaign-health`, guarded
  by a dedicated secret compared in constant time, reporting aggregate data
  only: feature flag, allowlist size, D1 reachability, applied migration count,
  content digest, rate-limit binding presence and enforcement, active/frozen
  session counts, and the age of the longest-frozen session. It returns 404 to
  everyone when the secret is unset, and 404 rather than 401 on a bad token.
- **A staging environment** — a separate Worker and a separate D1 database,
  sharing nothing with production but the source tree, plus a
  `db:migrate:d1:staging` script that names its own database rather than
  risking the production-only `db:migrate:d1:remote`.
- `wrangler deploy --dry-run` now runs in CI for both environments, validating
  bindings, routes and config against the installed Wrangler's schema on every
  push.
- **A session contention harness** that fires every actor in a campaign
  simultaneously against the same observed session version, in rounds, across
  nine campaigns at once, and asserts invariants rather than timings. The
  capacity harness measures the *steady* state — one writer per campaign at a
  relaxed cadence — so its commands never race, and the requirement to measure
  D1 contention was unmet by construction. On its first staging run this found a
  real defect: `expectedStructuralVersion` is advisory rather than enforced,
  because the precondition is checked against one read while the version claim
  uses a later one, so a concurrent structural command committing between them
  leaves the precondition stale without the guard or the unique index noticing.
  It reproduces on 3–5% of contended rounds against D1 and not at all locally,
  where the window is too small. Filed as issue #14 with the mechanism and the
  evidence; deliberately not fixed here, because the right fix needs a decision
  and a review.
- **Freeze, recovery and sanitized-end coverage across three real browser
  clients** — a GM freeze reaching every player unprompted, archiving refused
  while a session is frozen, recovery restoring play for everyone, and a GM
  ending a frozen session so private hands are destroyed while the public
  history survives with its checksum.
- **A rehearsed, forward-only rollback runbook**, and the harness that produced
  it, which drives a real disable → operator-only → re-enable cycle against
  staging and measures how long each step takes to take effect. The measurement
  is the finding: a rollback is **partial for roughly half a minute**. On the
  disable, `/sync` was already refusing at 332 ms while `/api/campaigns` still
  admitted and the health endpoint still reported the feature enabled, and
  campaigns stayed reachable through some route for 30 s after a deploy that
  exited cleanly; a stale isolate was observed surviving two consecutive
  deploys. The runbook's verification step is therefore "check from the
  perspective of a user who must now be refused, check several signals together,
  and require them to agree for ~15 s" rather than "read the health endpoint",
  and it tells operators to make one flag change at a time rather than chaining
  them.
- **A contributor guide.**

## [0.6.0] - 2026-07-27

### Added

- **Alpha notice and feedback loop**: every visitor sees an alpha banner warning
  that data may be lost, on every page including public share links. Dismissing
  it hides it for that browser tab only, so the warning returns on the next
  visit. The banner links to `/characters` for export, and to an optional
  `FEEDBACK_URL` for reporting issues; the feedback link is omitted when
  `FEEDBACK_URL` is unset. A branded error page carries the same links. A
  separate static `src/error.html` covers the one case that page cannot: when
  the root layout's own load fails, the app shell never boots, so SvelteKit
  renders that file instead — self-contained, and without the feedback link,
  since the value it would need comes from the load that just failed.
- **User activity tracking**: three new columns on `users` (`first_seen_at`,
  `last_seen_at`, `login_count`) record when each visitor first appeared, when
  they were last active, and how many times they have signed in. `last_seen_at`
  is refreshed on ordinary authenticated activity, at most once per UTC day —
  not only at sign-in — so it reflects returning visits rather than new
  sessions. `login_count` increments only on a genuine sign-in, and because
  sessions are long-lived JWTs it will read low for engaged users. Migration
  `0009_user_activity.sql` applies once; older backups cannot be backfilled
  retroactively with this data. **Deploy note — order matters, unlike 0008**:
  run `npm run db:migrate:d1:remote` **before** pushing this change to `main`.
  The `jwt` callback (`src/lib/server/auth-policy.ts`) reads these three
  columns on every authenticated request and is deliberately not wrapped in a
  try/catch, so deploying the code ahead of the migration is not harmless the
  way 0008 was: every returning sign-in between push and migration throws
  `no such column: users.first_seen_at`, 500ing or force-signing-out every
  beta tester until the migration runs.
- **Admin overview page** (`/admin`, gated by `ADMIN_EMAILS`): summary tiles for
  users, users active in the last 7 days, adventurers (split complete vs draft),
  adventurers created in the last 7 days, and denizens — plus two tables. **The
  users table displays real email addresses**, alongside first seen, last seen,
  sign-in count, and adventurer count; the adventurers table lists every
  adventurer with its owner. Archived and draft rows are shown and flagged, never
  filtered, so the page cannot disagree with the database. Access is restricted
  to signed-in users whose stored `users.email` appears in the comma-separated
  `ADMIN_EMAILS` variable — the address is read from the database column rather
  than the session claim, and anyone else receives a 404 rather than a 403, so
  the route's existence is not disclosed. An unset `ADMIN_EMAILS` means nobody
  has access, including the owner. Deploy note: set `ADMIN_EMAILS` in the
  Cloudflare Pages project's production variables after deploying this change.
- **Backup and restore runbook** (`docs/operations/backup-restore.md`): the
  snapshot, Time Travel, and restore-drill procedures behind the banner's
  data-loss warning, plus an incident-response checklist. The snapshot and drill
  sections ship marked **NOT YET PERFORMED** — the procedures are written and
  the commands verified, but the rehearsal has not been run, and the document
  says so rather than implying a recovery that has not been tested.

## [0.5.0] - 2026-07-25

### Added

- **Guided tests of fate at the shared table**: the GM calls for a test — naming
  the adventurer and the attribute — and the acting player settles it. Favor and
  disfavor are the GM's adjudication of the fiction; spending a point of Resolve
  for favor is the player's explicit pre-draw purchase, and pushing fate stays
  free and available only off a failure. Totals, the great-success condition, and
  all three Fool rules come from the existing resolution engine rather than a
  second implementation, and the Fool reshuffles both decks at the test's own
  boundary instead of waiting for the end of a round. Because *His Majesty the
  Worm* lets the GM call for a test mid-Challenge — and Camp's High Chant and the
  Augury spell each invoke one from inside their own procedure — a test runs
  alongside whatever procedure is already in progress rather than replacing it.
  The GM still narrates every consequence; the app supplies only the numbers.
- **Clean departures from a live table**: leaving a campaign — or being removed
  by the GM — during an open session is one atomic action. Every card the
  departing player privately held returns to its draw pile and the pile is
  shuffled, so nobody learns what they had; an active Challenge drops their
  seat; the public record shows only a count; and their access ends with their
  membership. Archiving a campaign is refused while a session is open (active
  or frozen) and archived campaigns stay read-only history for their members.
- **Completed session history and GM corrections**: ending a session already
  purged every private hand, prepared card, server draw order, and recipient
  secret; those completed sessions are now readable. The GM and every current
  member can list a campaign's completed sessions and open one to its ordered
  public log and final table — former members and outsiders get a 404, and
  history that stayed private when the session ended stays private forever,
  because the rows that held it no longer exist. A checksum stamps the ordered
  public history for corruption detection (documented as exactly that, not a
  signature). Mistakes at the table are repaired with audited compensating
  corrections: the GM names the event being corrected, a reason, and a legal
  card move — applied through the ordinary rules engine and appended to the
  journal, never an edit of it.
- **Oracles, exploration, and City procedures at the table**: every remaining
  in-session tarot procedure now runs through one data-driven engine — Area
  Sense, Overland Travel, the Camp watches and Patrol, We're Doomed,
  Maleficence (both invocation modes), Malediction, Random Totem, the GM twist,
  starting Dispositions, City Doomsaying, Strange Communions, As Above So
  Below, and the Augury spell with its private draw and accept-or-decline
  choice. Oracles resolve the drawn card against the book's own tables — single
  rows, ranges, the Random Totem grid, and Doomsaying's four-draw prophecy read
  left to right — and the verbatim cell text is what the table sees, with
  bracket tokens resolved from the top of the minor discard and
  cross-references linked to their entries. The flat 50% chances stay a manual
  yes/no that never draws a card, and the GM still adjudicates every
  consequence: the app supplies the rule text, nothing else.
- **Camp actions at the table**: the High Chant and leeches, the two Camp
  Actions whose mechanics are card operations. A bard selects inspiration cards
  from the minor arcana discard — as many as their Cups — and hands them out, at
  most one per adventurer. Each holder's card is theirs alone to see; everyone
  else sees only that they hold one, which is what keeps the one-per-player limit
  honest without turning a private card face-up. Inspiration survives the Camp
  phase and lasts until spent or the session ends. Leeches draw a card against
  another adventurer and report the rulebook's answer — nothing, or two charges
  toward curing an affliction — and say plainly that the table applies it,
  because the app never edits a character sheet.
- **Group tests**: the GM names the eligible group and the engine proposes the
  most- and least-qualified adventurers from their current attributes, flagging
  an apparent tie as the table's decision to talk out rather than presenting a
  ruling the book does not make. Each of the two adventurers runs a complete test
  with its own favor, Resolve, and push decisions; their hits total into the
  configured group outcome band.
- **Guided Challenge over the shared table**: campaigns can now run the full
  Challenge phase at the synchronized tarot table. The GM enters enemy facts as
  named groups, the engine deals each round from the content-defined formulas
  (players from the minor arcana, the GM's hand sized from enemy count, types,
  and threats), and every adventurer plays at one board. The procedure owns
  hands, facedown initiative and its public reveal, the one-card-per-turn budget
  with its action/minor-action exclusion, separate GM play and discard budgets,
  lesser/greater Doom predicates, the Fool interrupt (paired play, an extra turn
  with no minor actions, and a boundary reshuffle of both decks), the GM
  mulligan, and round cleanup — while health, wounds, range, position, and every
  fictional consequence stay manually adjudicated at the table.
- **Seven typed Challenge modifiers** — black honey, stun, brainfever, counsel,
  guardian angel, aim, and the shield Guard action — each driven entirely by
  content parameters, with private card transfers whose public events carry only
  a count and reason, never a card identity.
- **Death and legal replacement during a Challenge**: marking a participating
  adventurer dead is a single atomic mutation (character version claim, life
  state, tenure end, private-zone redaction, participant update, public events,
  and freed membership), and a replacement adventurer joins only at the next
  round boundary, never midway through a deal.
- A projection-driven Challenge table UI: components render controls solely from
  the server-derived legal-command set, submit idempotent commands scoped per
  intent, and announce deal counts, initiative order and ties, turns, plays,
  round transitions, and completion for assistive technology. The feature stays
  allowlisted behind `CAMPAIGNS_ENABLED` or pilot user IDs.
- **People in the denizen builder**: the Man theme now follows the book's
  "make actual characters" advice as an adversary path. Choosing it swaps the
  wizard to a Person step (replacing Threat): the adventurer 4/3/2/1 spread
  assigned by swap, an optional flavour-only kith recorded as a stat-block
  note, a kin whose arete talent joins the block, path talents offered from
  the path matching their highest attribute (other paths behind dropdowns),
  HD pre-filled for simplicity (with an optional switch to proper Wounds
  tracking and a checklist note of the book's wound options), and custom
  gimmick dooms instead of template pick-lists. Exports omit the threat line
  entirely for people. Switching themes — person to creature or between
  creature template pairs — stashes and restores each side's work instead
  of discarding it. Content pack bumped to 3.4.0 (person seed rules in
  `denizens.json`, Man theme builderMode) with the digest re-recorded.

### Fixed

- **A Resolve spend can no longer blank a character sheet**: if the stored
  document could not be migrated, the narrow Resolve write fell back to a blank
  character and wrote it back — losing name, attributes, equipment and notes. A
  document the server cannot read now refuses the spend instead.
- **Removing a player mid-Challenge keeps the right adventurer's turn**: the
  active initiative seat was clamped rather than followed, so removing an
  earlier seat silently handed the turn to the next player along, and removing
  the last seat left a turn pointer on an empty order.
- **Corrections can only move a card the table can already see**: the GM's
  compensating correction accepted any source zone, so it could lift a card out
  of a hand or off a draw pile and publish its identity. Sources are now limited
  to public areas and discard piles, the corrected event must belong to the
  session, and a correction confirmed against one board is refused rather than
  re-applied if the table moved on.
- **Oracle procedures are now fully drivable from the table**: the panel never
  sent Maleficence's realm, could only answer "yes" to a chance gate, had no way
  to decline an Augury, and could not submit a card order — so several
  procedures the engine supported were unreachable in the app.
- **A procedure step can no longer be skipped past another player**: choosing a
  later branch marked the intervening steps skipped without checking whose they
  were, letting a player jump the GM's step or the GM pre-empt the player's
  choice.
- **Archived campaigns keep their history**: the completed-session pages used
  the access check that excludes archived campaigns, so archiving a campaign
  404'd its own history for its members.
- **The site navigation now wraps on narrow screens**: an unwrapped nav row made
  every page scroll sideways at phone widths and at 200% browser zoom.
- **Tarot cards now announce themselves to screen readers**: card faces and
  backs carried a label with no role, so assistive technology had no name for
  any card. Card controls also name the card and its position ("Play X of Cups",
  "Card 1 of 3"), while a face-down card is only ever announced as "Face-down
  card" — the identity never rides on a label.
- **A discarded card now lands on top of its discard pile**: the newest
  discard was previously buried at the bottom, so any rule reading "the top
  card of the discard pile" — the GM twist, starting Dispositions, the bracket
  tokens — would have read the oldest discard instead.
- **Stun now matches the rulebook**: the content pack described Stun as
  discarding a player's entire hand; it discards one card, chosen by the
  affected player. Content pack bumped to 3.3.0.
- **Sessions pinned before the Stun correction are cleared**: a session is
  loaded through the runtime content it pinned at start, so any session begun
  under the old Stun shape could no longer be read — and a session that cannot
  be read cannot be projected, recovered, or ended, while still holding its
  campaign's single open-session slot. `0007_purge_pinned_sessions` removes
  play sessions and their session-scoped rows once, leaving campaigns,
  memberships, characters, tenures, and non-session campaign history intact.
  This is a deliberate pre-release exception to the forward-only rule, not a
  precedent; the roadmap now records why freezing was no answer here.
- **An unloadable session no longer looks like no session at all**: the table
  page told the GM "No session is currently open" over a session that was very
  much open, offering a "Start session" button whose action could only ever
  refuse. Session loads now distinguish "not found" from "cannot be loaded" —
  without ever confirming a session outside the caller's campaign — the table
  explains the wedged state instead of hiding it, integrity failures are logged
  for the operator rather than swallowed, and a refused start says why.

## [0.4.0] - 2026-07-25

### Added

- **Guided Challenge over the shared table**: campaigns can now run the full
  Challenge phase at the synchronized tarot table. The GM enters enemy facts as
  named groups, the engine deals each round from the content-defined formulas
  (players from the minor arcana, the GM's hand sized from enemy count, types,
  and threats), and every adventurer plays at one board. The procedure owns
  hands, facedown initiative and its public reveal, the one-card-per-turn budget
  with its action/minor-action exclusion, separate GM play and discard budgets,
  lesser/greater Doom predicates, the Fool interrupt (paired play, an extra turn
  with no minor actions, and a boundary reshuffle of both decks), the GM
  mulligan, and round cleanup — while health, wounds, range, position, and every
  fictional consequence stay manually adjudicated at the table.
- **Seven typed Challenge modifiers** — black honey, stun, brainfever, counsel,
  guardian angel, aim, and the shield Guard action — each driven entirely by
  content parameters, with private card transfers whose public events carry only
  a count and reason, never a card identity.
- **Death and legal replacement during a Challenge**: marking a participating
  adventurer dead is a single atomic mutation (character version claim, life
  state, tenure end, private-zone redaction, participant update, public events,
  and freed membership), and a replacement adventurer joins only at the next
  round boundary, never midway through a deal.
- A projection-driven Challenge table UI: components render controls solely from
  the server-derived legal-command set, submit idempotent commands scoped per
  intent, and announce deal counts, initiative order and ties, turns, plays,
  round transitions, and completion for assistive technology. The feature stays
  allowlisted behind `CAMPAIGNS_ENABLED` or pilot user IDs.
- **Saved denizens**: signed-in users can save denizens from the builder's
  review step, list and archive them at `/denizens/mine` (archiving is one-way
  for now), view and re-export each at `/denizens/mine/[id]`, and edit them
  back in the builder. The reference shows a "Your denizens" strip when signed
  in with saved denizens. Saving stores the sanitized draft as the single
  source of truth (definitions re-materialize on render), validates template
  ids and stat invariants server-side, and bounds the request itself — a
  byte-true payload cap plus a per-user row ceiling. Every write is guarded
  by an integer version claim in the update statement, like character saves:
  a stale tab gets a conflict answer, never a silent overwrite, and "New
  denizen"/"Save as a new copy" explicitly detach the builder from the saved
  row so starting fresh can never clobber it. All user-scoped denizen pages
  and API responses are `private, no-store`. Anonymous building and exporting
  are untouched — saving is the only signed-in feature. Every bestiary entry
  with builder-supported templates gains "Customize in the builder", loading
  a pre-filled copy as a new custom denizen. Save failures show inline next
  to the button, and the header's Sign in link returns you to the page you
  were on, query string included. Deploy note: run
  `npm run db:migrate:d1:remote` (additive `denizens` table, migration 0008)
  when deploying.
- **People in the denizen builder**: the Man theme now follows the book's
  "make actual characters" advice as an adversary path. Choosing it swaps the
  wizard to a Person step (replacing Threat): the adventurer 4/3/2/1 spread
  assigned by swap, an optional flavour-only kith recorded as a stat-block
  note, a kin whose arete talent joins the block, path talents offered from
  the path matching their highest attribute (other paths behind dropdowns),
  HD pre-filled for simplicity (with an optional switch to proper Wounds
  tracking and a checklist note of the book's wound options), and custom
  gimmick dooms instead of template pick-lists. Exports omit the threat line
  entirely for people. Switching themes — person to creature or between
  creature template pairs — stashes and restores each side's work instead
  of discarding it. Content pack bumped to 3.4.0 (person seed rules in
  `denizens.json`, Man theme builderMode) with the digest re-recorded.

### Fixed

- **Stun now matches the rulebook**: the content pack described Stun as
  discarding a player's entire hand; it discards one card, chosen by the
  affected player. Content pack bumped to 3.3.0.
- **Sessions pinned before the Stun correction are cleared**: a session is
  loaded through the runtime content it pinned at start, so any session begun
  under the old Stun shape could no longer be read — and a session that cannot
  be read cannot be projected, recovered, or ended, while still holding its
  campaign's single open-session slot. `0007_purge_pinned_sessions` removes
  play sessions and their session-scoped rows once, leaving campaigns,
  memberships, characters, tenures, and non-session campaign history intact.
  This is a deliberate pre-release exception to the forward-only rule, not a
  precedent; the roadmap now records why freezing was no answer here.
- **An unloadable session no longer looks like no session at all**: the table
  page told the GM "No session is currently open" over a session that was very
  much open, offering a "Start session" button whose action could only ever
  refuse. Session loads now distinguish "not found" from "cannot be loaded" —
  without ever confirming a session outside the caller's campaign — the table
  explains the wedged state instead of hiding it, integrity failures are logged
  for the operator rather than swallowed, and a refused start says why.

## [0.3.0] - 2026-07-20

### Added

- **Dungeon lords in the denizen builder**: threats fought in named pools of
  Health and Defense are now fully buildable. A new Pools step (shown only for
  pool-based threats) adds, names, reorders, and removes pools, each with its
  own HD pair, defeat text, notes, and lesser/greater dooms; Customize gains a
  special-rules field and drops top-level HD for these threats. Pool invariants
  from the book surface as live warnings (every pool a complete HD pair, at
  least one pool, no top-level HD alongside pools), and exports never render a
  blank pool HD. Builder position is now persisted by step id so the
  mode-dependent step path survives reloads and threat switches; existing
  drafts migrate in place.

## [0.2.0] - 2026-07-19

### Added

- A server-gated campaign foundation: Game Masters can create guilds, manage
  revocable invitations, inspect current and historical membership/adventurer
  tenures, and archive a campaign; players can explicitly join as observers,
  attach or replace one eligible adventurer, leave, and record or correct
  character death. Campaign pages and APIs are private/non-cacheable, and the
  rollout remains off by default behind `CAMPAIGNS_ENABLED` or pilot user IDs.
- D1/SQLite campaign constraints and conditional mutation claims make invite,
  membership, tenure, character-life, and session-boundary races atomic. Raw
  invitation tokens are never stored, and all character writes now use integer
  version claims.
- A live shared tarot table for campaigns: the GM starts a session and every
  attached adventurer plays at one synchronized board. The server owns all 78
  cards — shuffles, draws, and destinations — and each browser receives only a
  role projection: your own hand's faces, card backs and counts for everything
  hidden, and the public zones (initiative, played, revealed, inspiration).
  Cards move through a generic command set (draw, deal, play, place face down,
  reveal, discard, transfer, mulligan, end round) driven by the projection's
  legal actions; the GM can freeze, resume, and end the table, and ending purges
  every unrevealed secret and leaves a public-only history. Changes reach every
  visible table within two seconds over plain polling — no WebSockets — and
  polling pauses in hidden tabs. Session rules are pinned at start from an
  immutable content snapshot, so a mid-campaign content update never changes a
  live table. Commands are idempotent (a double-click or retry applies once) and
  every card mutation is a single atomic version claim on both SQLite and D1;
  privacy is enforced by construction and guarded by canary tests across
  response bodies, headers, errors, logs, and event rows. Remains gated behind
  `CAMPAIGNS_ENABLED` / pilot user IDs.

- The complete test-of-fate resolution engine: favor/disfavor, spending Resolve
  for favor, pushing fate, all three Fool rules, and group tests. `/deck` is now
  its reference client, with favor/disfavor/Resolve controls and a result panel
  that explains the ruling rather than only showing a total. `/deck?seed=` pins
  the shuffle for a reproducible run.
- Doom tiers, the favor modifier, and the group-test hit table are content
  (`index.json`), each citing the rules entry it came from, so no game rule is
  hardcoded in the engine. Schema refinements reject a malformed major arcana
  (22 cards, one Fool at 0, I–XXI once each) and group bands that fail to
  partition every reachable hit total.

- An audited catalog of every in-session tarot procedure
  (`tarot-procedures.json`), generated from a committed manifest and the
  rulebook rather than hand-authored: 30 procedures, 14 verbatim oracle lookup
  tables (194 rows — Meatgrinder, City Events, Signs and Portents, Hangover, the
  four Maleficence tables, Malediction, Random Totem, Doomsaying, and the rest),
  7 typed modifiers, and 3 formulas. Tables carry inclusive card ranges, live
  `[value]`-style tokens, and cross-references to real bestiary entries. Every
  card-keyed table is proven to claim each card of its deck exactly once.
- `docs/rules/tarot-procedure-audit.md` — the scope contract. Every tarot-bearing
  rule in the book, enumerated once and classified `supported-v1`,
  `deferred-preparation`, or `not-applicable-non-tarot`, each with a source and a
  rationale. Preparation generators (the Job Board, City and Underworld creation)
  are deferred by name; flat "50% chance" rules stay manual and are never
  simulated with a card draw.
- Content-pack integrity and version enforcement (`verify-pack-version.mjs`,
  wired into CI): a SHA-256 digest over every generated file rejects hand-edited
  output, and a content change under an unchanged pack version fails the build. A
  play session pins its pack version at start, so generated content must never
  change under a version it already served. Pack version is now 2.0.0.

- The rules reference now covers the four phase chapters and the in-session
  rules they lean on: Crawl (Meatgrinder, light and We're Doomed, Disposition),
  Challenge (the round sequence, Initiative, facedown cards, the Fool, Dooms,
  and the GM hand-size formula), Camp (Patrol, No Rest for the Wicked, Overland
  Travel), and City (City Events, Signs and Portents, Beg & Busk, Carouse).
  Cross-chapter in-session rules are imported alongside them: Area Sense,
  Counsel, High Chant, Creating Surprises, and the live tarot spells (Augury,
  Brainfever, Maleficence, Malediction, Totem, Guardian Angel). 44 new entries,
  extracted by the pipeline rather than retyped.
- The Elite/Dungeon Lord "draws an additional Challenge card" mechanic is now
  surfaced in the reference as `challenge-gm-hand-size`, closing a TODO left
  when Appendix C landed. It is a Chapter 7 hand-size procedure keyed to threat
  type (+2 for an elite, +3 for a dungeon lord), deliberately not stored on the
  stat blocks; a manifest sentinel now fails the build if the clause ever drops
  out of extraction.

- Rules entries may opt into `keepCallouts`, which converts an Obsidian callout
  into the reference's markdown dialect (title becomes a sub-heading, body
  becomes paragraphs) rather than dropping it. Callouts are still stripped by
  default, since most are flavour sidebars; `challenge-facedown-cards` is the
  only entry that opts in, because Chapter 7 states the facedown-card privacy
  rule — "Nobody but the player can look at the facedown card" — in a sidebar
  rather than in body prose.
- Anonymous adventurer exports on the wizard review step; PDF and Markdown downloads no
  longer require saving or signing in. Denizen creation and exports remain anonymous.
- An Account page showing linked Google and Discord providers, with explicit linking for
  signed-in users.

### Fixed

- `md-rules.mjs` ignored a manifest entry's `after` anchor, so an entry
  disambiguating a repeated heading silently imported the first match instead of
  the intended one. Chapter 7 alone has five such headings — `1. Draw Challenge
  cards` occurs three times (flow summary, player rule, GM rule). `md-inject.mjs`
  already honoured `after`; the two importers now agree. No previously committed
  entry used `after`, so existing output is unchanged.

### Security

- Replaced automatic same-email OAuth merging with Auth.js adapter-managed account
  linking. Signed-out provider collisions are rejected; linking a second provider now
  requires an authenticated session.
- Added database uniqueness constraints for provider identities and normalized emails,
  omission of unverified provider emails without denying sign-in, legacy/deleted-user
  session invalidation, and OAuth token minimization.
- Added a read-only rollout preflight for duplicate provider identities and normalized
  email collisions; the migration preserves existing users and adventurers.

### Removed

- `/licensing`: the per-typeface licence tracker table. The page now carries a
  short IM Fell English / OFL credit instead; per-face licence status stays in
  `static/fonts/LICENSES.md`, which remains the source of truth (and still flags
  Goudy Old Style as needing a Monotype webfont licence before public launch).

## [0.1.0] - 2026-07-14

### Added (dungeon denizens)

- **Denizen reference** (`/denizens`): the full Appendix C bestiary (27 creatures,
  including the multi-pool dungeon lords), browsable with theme/threat filters and
  name search, plus the six theme and five threat templates. Book text reproduced
  directly — confirmed open content by the author.
- **Denizen builder** (`/denizens/build`): a six-step wizard following the book's
  "monstrous mixology" recipe — concept, theme, threat, seeded stat block,
  template doom pick-lists plus custom dooms, and a live stat-block review. Draft
  persists in localStorage.
- **Denizen export**: Obsidian-flavored Markdown (copy or download) and a one-page
  stat-block PDF, from both the reference and the builder.
- Denizens Playwright e2e suite (`tests/e2e/denizens.spec.ts`); the e2e web server
  now boots without a real `AUTH_SECRET`.
- Builder capability metadata in the content pack (`builderMode`/`builderNote`):
  pool-based (Dungeon Lord) and description-only (Man) templates are
  reference-only in the builder, with the reason shown in place.
- Stat invariants from the book enforced in the schema and as live builder
  warnings: Health starts at 1+ (or ∞), Defense may be 0, Health/Defense travel
  as a pair, and blank stats are omitted from stat blocks and exports.
- Export buttons announce clipboard/PDF failures to the screen-reader live
  region, disable while working, and retry font loading after a failed fetch.
  Persisted builder drafts are validated field by field on load.

### Added

- A Markdown-driven content pipeline for the complete current pack, including all
  49 talents, 66 market items, 40 spells, and ten scoped Chapter 1 rules entries.
- Drift checks and content-integrity tests for imported prose, rule boundaries,
  malformed headings, and known source-export corruption.
- A browser smoke test for the character wizard, attribute allocation, theme
  control, footer, and licensing presentation; CI now runs it alongside the
  Cloudflare production build.

### Changed

- Re-derived rulebook prose from the clean per-chapter Markdown vault and retired
  the PDF extraction pipeline. Descriptions retain Markdown structure and render
  through the shared prose component.
- Corrected motifs to the book's 50 descriptors and 50 professions and added the
  four complete sorcery traditions as content-pack data.
- Simplified wizard choices into compact name-first controls with revealed,
  structured descriptions; shortened kith introductions and compacted attribute
  assignment into a matrix that disables values already in use.
- Moved the Adherent of the Worm mark from the global footer to the licensing page
  and replaced the custom theme glyph with standard moon and sun icons.

### Fixed

- Preserved paragraph breaks around imported Markdown headings and omitted
  explicitly anchored incomplete or corrupt source-export fragments instead of
  publishing damaged or invented text.
- Corrected content extraction boundaries that could absorb neighboring entries.

### Added (pre-deploy content & play-tracking push)

- **Real content pack**: kith & kin with their arête triggers and talents, the
  four paths with all seven talents each (49 unique talents), the full Omphalic
  Market (all three tiers, weapons, ammunition), the four conditions, and staged
  afflictions — mechanics summarised in original wording under the Adherent of
  the Worm open licence. Placeholder pack retired.
- **Encumbrance**: the book's slot model (Hands 2 / Belt 4 / Backpack 21; worn
  armor bills belt slots 1/2/3; oversized gear is belt-only; stackables share
  slots) as a pure engine, with live meters + auto-placement in the wizard's
  market step and talent-required items marked impoverished-for-you.
- **Sheet editing & play tracking**: an Edit mode (story, talents with
  state/XP/add/remove, gear with locations, quantities, and notches) and an
  always-visible Status panel — condition toggles with rule hints, a guided
  "Take a Wound" menu (notch gear / wound a talent, hard-capped at two /
  mark a condition), staged afflictions, bonds with charged pips, resolve and
  lore trackers. Status changes autosave; edits save explicitly; both ride the
  optimistic-concurrency PUT. Character schema v2 with transparent migration.
- Exports and the read-only sheet now carry play state (wounded talents,
  conditions, afflictions, gear locations/notches, load summary).

### Fixed

- Draft adventurers can now be finalized from their sheet: a "Save as final"
  button in the draft banner promotes the draft (running the server's
  final-validation gate — incomplete drafts get a "Still missing: …" list
  instead of saving broken).

- Tailwind utility-class collision: local `fixed` / `table` class names were
  picked up as Tailwind utilities (`position: fixed`, `display: table`), which
  pulled the attributes page's locked value and the kin-talent card out of
  document flow (overlapping text/cards). Renamed the classes.
- Repaired Caslon Antique's zero `hhea` vertical metrics (ascent/descent were
  0/0), which collapsed every button's line box — button text now centres
  properly; primary action buttons also got larger text.
- Attribute assignment dropdowns now filter live: a value chosen for one suit
  disappears from the other suits' dropdowns.
- Removed the "(Placeholder talents…)" aside from path-selection cards; the
  three motif inputs now show three different example placeholders.

### Added

- Project scaffold: SvelteKit 2 + Svelte 5 (runes) + TypeScript strict + Tailwind v4,
  mirroring the Miskatonic University Registrar architecture.
- Env-switched build adapter (Cloudflare / Node / auto) and Drizzle + D1 configuration.
- Placeholder landing page, root layout with the required "Adherent of the Worm"
  licensing notice in the footer, and OFL fallback typography.
- Keep a Changelog `CHANGELOG.md`, GPL-3.0 `LICENSE`, and CI workflow (check + unit tests).
- Content-pack type model grounded in the His Majesty the Worm rules: four
  suit-attributes (Swords/Pentacles/Cups/Wands), two-level Kith & Kin, Paths,
  Talents (mastered/in-training), Omphalic Market item tiers, and a full tarot
  config (minor arcana I–King with values, 22 major arcana, 14+ resolution).
- `GuildBookCharacterData` character shape with audit-trailed allocations and a
  `createBlankCharacter()` factory (schema v1).
- Zod schemas for the content pack and character blob, a placeholder `hmtw`
  content pack (marked `"license":"placeholder"`), and a validating,
  singleton-cached content loader.
- Unit tests: schema round-trip, tarot/creation-rule invariants, and
  cross-file referential integrity for the pack.
- `scripts/fetch-rwsa-tarot.sh`: downloads the full-resolution 1909 Pam-A
  Rider-Waite-Smith scans from steve-p.org into `assets-src/tarot/rwsa/`
  (gitignored source material for the virtual tarot deck; permission from the
  site owner required before shipping the images publicly).
- Authentication (Auth.js): Google + Discord OAuth plus a dev credentials
  provider and an optional gitignored dev auto-login bypass, with secure
  account-linking (verified-email merge only) and a JWT session strategy.
- Database: dual-target Drizzle resolver (Cloudflare D1 in production,
  better-sqlite3 locally), Auth.js tables, a `characters` table (JSON blob +
  `shareId`), schema-only guild tables for a clean future migration, and the
  initial migration.
- `hooks.server.ts`: db injection into locals, same-origin guard on mutations,
  per-IP write rate limiting, and security headers. Login page and session-aware
  header (sign in / sign out / My Adventurers).
- Character persistence API: `GET/POST /api/characters`, `GET/PUT/DELETE
  /api/characters/[id]` (optimistic-concurrency `expectedUpdatedAt`, soft
  archive), and `POST/DELETE /api/characters/[id]/share`. Server-side
  final-validation gate (kith/kin/path chosen, 4/3/2/1 spread with the 4 on the
  path's suit) applied to non-draft saves.
- Public read-only share links: `/s/[shareId]` anonymous view with a shared
  `CharacterSheet` component, and a "My Adventurers" (`/characters`) roster with
  archive. Migrate-on-read normaliser (`engine/character-migration.ts`) and a
  reusable display-model builder (`server/character/view.ts`).
- Unit tests for migration and final-validation logic.
- Pure engine layer (`src/lib/engine/`): seedable RNG + Fisher–Yates shuffle
  (`rng.ts`); tarot deck builder (`tarot-deck.ts` — 56 minor + Fool player deck,
  21-card GM deck, seeded shuffle, draw); test-of-fate resolution
  (`tarot-resolution.ts` — data-driven 14+ thresholds; great success requires an
  un-pushed initial tested-suit draw; great failure is a pushed-and-still-failed
  test); attribute assignment (`attributes.ts` — 4/3/2/1 spread with the 4 locked
  to the path suit, provenance-tracked); and Kith/Kin + Path grants
  (`kindred.ts`, `calling.ts` — kin mastered talent, one mastered path talent).
- Engine unit tests: deck integrity/shuffle determinism, resolution outcomes,
  spread assignment, and grant assembly (36 tests total).
- Creation wizard: an eight-step, localStorage-persisted flow (identity →
  kith & kin → path → attributes → talents → quest & motifs → gear → review),
  content-pack-driven and wired to the engine. Path precedes Attributes so the
  4 locks to the chosen path's suit; the review step validates and saves via the
  characters API. Includes `WizardShell` (step indicator, progress, start-over,
  keyed remount), a shared step-nav, and a live-region announcer for a11y.
- Verified the full wizard end-to-end in a real browser (build an adventurer →
  save → appears in the roster), including a fix so post-save navigation reaches
  `/characters` instead of being intercepted by the deep-link guard.
- Virtual tarot deck at `/deck` (no auth): a free-form table deck (draw / discard
  / reshuffle / reset) that auto-reshuffles the discard when the draw pile empties
  (with a visible cue), and a guided **test of fate** mode (pick attribute + suit,
  draw, push fate, see the outcome). Original CSS card art — no book art. Includes
  a JSON-serializable draw protocol (forward-compatible with the guild-draw log),
  a client deck store wrapping the pure engine, and a persisted animate toggle.
- Pure `drawWithReshuffle` engine helper (+ tests) so the auto-reshuffle logic is
  covered independently of the UI.
- Rules reference at `/rules` (index with live client-side search + section
  grouping) and `/rules/[section]` (focused view), driven by the content pack's
  `rules.json`. A minimal, HTML-escaping Markdown renderer (`utils/markdown.ts`,
  + tests) renders the rule bodies safely.
- Book typography & theme system: self-hosted the "Adherent of the Worm" template
  faces as woff2 (Bilbo Display H1, HamletOrNot headings, Caslon Antique subheads,
  IM Fell English body, Dark Roast quotes, Goudy Old Style + Kelmscott sidebars),
  wired to `--font-*` role tokens. Parchment-light and worm-dark oklch themes with
  a persisted, no-FOUC theme toggle. Original ornamental components (DecoCorner,
  OrnamentalBorder, CardTable), the permitted Adherent-of-the-Worm logo in the
  footer, and a `static/fonts/LICENSES.md` status manifest (flags Goudy Old Style
  as needing a webfont licence before public launch).
- Owner adventurer sheet at `/sheet/[id]` (the roster's link target) with export
  and share actions. PDF export (pdfmake, original one-page layout, required
  copyright notice, no book art) and Obsidian-flavored Markdown export — both
  from a pure builder over the resolved `CharacterView` (moved to
  `types/character-view.ts` so client exporters avoid server imports). Share
  dialog to mint/copy/revoke public links. `/licensing` page with the mandated
  notice, GPL-3.0 source, and the font-licence table. Unit tests for the PDF and
  Markdown builders.

[Unreleased]: https://github.com/arrowedisgaming/guild-book/commits/main
