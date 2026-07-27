# Alpha Beta-Readiness — Design

**Status:** Approved in conversation on 2026-07-27

## Goal

Prepare Guild Book for a cohort of beta testers arriving later in the week of
2026-07-27. Three outcomes:

1. Every visitor is told, on every page, that this is alpha software and that
   their data may be lost — and is pointed at the export they already have.
2. The owner can see who signed up, what they built, and whether they came
   back, from a single admin-only page.
3. The data behind (2) starts accruing *before* the testers arrive, and the
   data-loss warning in (1) is backed by a rehearsed recovery procedure rather
   than an assumption.

This is a beta-enablement bundle, not a scaling project. It is deliberately
small.

## Scope ruling — campaigns stay dark

Beta testers exercise the **single-player surface only**: character creation,
the character sheet, denizens, the deck, and the rules reference.
`CAMPAIGNS_ENABLED` stays off and no beta user IDs are added to
`CAMPAIGNS_PILOT_USER_IDS`.

This is what keeps the bundle small. The shared tarot table's polling and
command write paths are the only parts of the app with meaningful concurrency
pressure, and with them dark, none of
`docs/superpowers/plans/2026-07-15-campaigns-increment-5-enablement.md` is a
prerequisite here. In particular:

- **The rate limiter is knowingly left as-is.** `src/hooks.server.ts` keys its
  60-writes-per-minute budget off an in-process `Map`, which on Cloudflare is
  per-isolate — so the real budget is looser than it reads. Fixing it is
  Increment 5 Task 1's job and depends on the Pages → Workers migration
  landing first. Out of scope. Recorded here so the gap is a decision and not
  an oversight.
- Increment 5's campaign metrics, staging-D1 contention runs, and capacity
  gates all remain deferred.

## Owner rulings

### Activity tracking extends the JWT callback's existing read

`createAuthCallbacks` in `src/lib/server/auth-policy.ts` already performs a
primary-key `select` against `users` on every authenticated request, to prove
the signed JWT has not outlived its user row. Activity tracking widens that
existing query by one column rather than adding a second lookup.

Rejected alternatives: doing it in `src/hooks.server.ts` (puts a read and a
conditional write on the hot path for static assets and API calls, in a file
already carrying origin checks and rate limiting), and doing it in the root
`+layout.server.ts` load (cheaper than the hook, but adds a `users` read the
layout does not currently perform, and misses API-only activity).

Accepted cost: `auth-policy.ts` stops being a pure policy module and performs
a write. The alternative was a second per-request lookup existing only to
preserve that property.

### The banner renders visible and hides on mount

A user who has already dismissed the banner will see a brief flash of it
before `sessionStorage` is read. The inverse design — render hidden, reveal
after JS confirms — flashes *no warning* at every user on every page. The
error is deliberately biased toward over-warning.

### Non-admins get 404, not 403

A beta tester probing `/admin` should not learn the route exists.

### Login counts measure sessions, not visits

Under the JWT strategy a sign-in yields a long-lived token, so `loginCount`
counts new sessions and will read low for engaged users. `lastSeenAt` is the
honest engagement signal; `loginCount` is retained because it distinguishes a
user who signed in once and left from one who returns deliberately.

## Architecture

### 1. Data model

Three additive columns on `users` in `src/lib/server/db/schema.ts`. All are
nullable or defaulted, so the generated migration is additive and needs no
backfill on D1:

```ts
firstSeenAt: integer('first_seen_at', { mode: 'timestamp' }),
lastSeenAt:  integer('last_seen_at',  { mode: 'timestamp' }),
loginCount:  integer('login_count').notNull().default(0)
```

Existing rows migrate with `loginCount = 0` and null timestamps; the admin
view renders those as "—" rather than fabricating a date. **These values
cannot be backfilled** — every pre-migration sign-in is unrecoverable, which
is why the migration must be deployed before the testers arrive.

### 2. Activity decision logic — `src/lib/server/admin/activity.ts`

A pure function, following the repo's engine convention: no DB access, no
`$app/` imports, no clock reads of its own.

```ts
export interface ActivityState {
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
  loginCount: number;
}

export interface ActivityPatch {
  firstSeenAt?: Date;
  lastSeenAt: Date;
  loginCount?: number;
}

export function activityPatch(input: {
  now: Date;
  isSignIn: boolean;
  current: ActivityState;
}): ActivityPatch | null;
```

Rules:

- Returns `null` when `isSignIn` is false and `current.lastSeenAt` falls on
  the same **UTC** day as `now` — the common case, and the reason this is one
  write per user per day regardless of traffic volume.
- `loginCount` is incremented only when `isSignIn` is true.
- `firstSeenAt` is set only when currently null.
- `lastSeenAt` is always set on any returned patch.

UTC is the day boundary, chosen so the function stays pure and deterministic
in tests and so the figure does not shift with server locale.

### 3. Applying the patch — `src/lib/server/auth-policy.ts`

`createAuthCallbacks`'s `jwt` callback gains the write in both branches:

- `user?.id` branch (a genuine sign-in) → `activityPatch({ isSignIn: true, … })`.
- `token.sub` branch (an existing session) → the existing `select` widens from
  `{ id }` to `{ id, firstSeenAt, lastSeenAt, loginCount }`, and the result
  feeds `activityPatch({ isSignIn: false, … })`.

The existence check on the widened query is unchanged: a missing row still
returns `null` and invalidates the token.

**The write is wrapped in `try`/`catch` and its failure is swallowed with a
`console.warn`.** A D1 hiccup on an analytics write must never cause the
callback to return `null`, because that signs every affected user out. This is
the single most important constraint in this design.

### 4. Admin gate — `src/lib/server/admin/config.ts`

Mirrors the shape of `src/lib/server/campaign/config.ts`:

```ts
export interface AdminConfig { adminEmails: ReadonlySet<string> }
export function getAdminConfig(event: RequestEvent): AdminConfig;
export function isAdminEmail(config: AdminConfig, email: string | null): boolean;
```

`getAdminConfig` reads `ADMIN_EMAILS` via the existing `getEnv` helper —
comma-separated, each entry trimmed and lowercased. An unset or empty value
yields an empty set, so **nobody is an admin by default**. `isAdminEmail`
returns false for a null or empty email.

`requireAdmin(event)` composes `ensureUser` with a `users.email` lookup by id
and the set check, throwing `error(404)` on failure. It resolves the email
from **the database row, not `session.user.email`** — `verifiedProviderEmail`
only persists provider emails the provider itself marked verified, so the
stored column is the trustworthy one.

`ADMIN_EMAILS` is an env var rather than a source constant so the admin set
can change without a redeploy and no personal address is committed to the
repository.

### 5. Admin page — `/admin`

A server load plus a page component. No new API routes: nothing here needs to
be callable, and keeping it out of `/api` keeps the public API surface
unchanged.

- `src/routes/admin/+page.server.ts` — `requireAdmin`, then the queries.
- `src/routes/admin/+page.svelte` — tiles and tables.

**Summary tiles** (six): total users; users with `lastSeenAt` within 7 days;
total adventurers; completed vs draft split; adventurers created within
7 days; total denizens. Every figure is a SQL aggregate — no query pulls rows
into JS to count them.

**Users table:** name, email, first seen, last seen, login count, adventurer
count. Ordered by `lastSeenAt` descending with nulls last.

**Adventurers table:** name, kith, path, owner name, draft/complete, created,
updated. Ordered by `createdAt` descending.

**Archived and draft rows are included everywhere and flagged, never
filtered.** Both `characters` and `denizens` carry `isArchived`, and
`characters` carries `isDraft`. Silently excluding either would make the
owner's only view of the system disagree with the database, which defeats the
point of the page. The draft/complete tile reports the split explicitly; the
adventurers table shows archived rows with a visible marker.

Both tables paginate at 50 rows via independent query params (`usersPage`,
`charactersPage`). Column sorting is driven by a **hardcoded allowlist mapping
param values to Drizzle column references** — the request value never reaches
`orderBy` directly. An unrecognised sort param falls back to the default order
rather than erroring.

The page sets `noindex`.

### 6. Alpha banner — `src/lib/components/layout/AlphaBanner.svelte`

Rendered in `src/routes/+layout.svelte` as the first child of `.site`, above
`.site-header`. Because it lives in the root layout it also appears on public
share pages at `/s/[shareId]`, which is intended — someone viewing a shared
character should know what they are looking at.

Contents: the alpha and data-loss statement; an "Export your adventurers" link
to `/characters`, where the existing `CharacterExportButtons.svelte` PDF and
JSON actions already live; a feedback link rendered **only when**
`FEEDBACK_URL` is set; and a dismiss button.

`FEEDBACK_URL` is read server-side with the existing
`getEnv(event, 'FEEDBACK_URL')` helper and surfaced to the client through the
root `+layout.server.ts` return value, alongside `appVersion` and
`showCampaignsNav`. It deliberately does **not** use SvelteKit's `$env/*`
modules or a `PUBLIC_` prefix: this repository reads every setting through
`getEnv` so the same code path works for Cloudflare bindings and Node
`process.env`, and breaking that pattern for one variable would be the only
exception in the codebase. The value is a plain URL, safe to expose. Where the
root layout load has not run — an early error boundary — the link is simply
absent.

Dismissal writes a key to `sessionStorage`, so the banner returns on the
tester's next visit and the warning can never be permanently silenced.

Accessibility:

- **No `role="alert"` and no `aria-live`.** Either would interrupt screen
  reader users on every single navigation for the entire beta. The banner is
  ordinary text placed first in the DOM, so assistive technology encounters it
  before the header regardless.
- The dismiss button carries an explicit `aria-label`.
- The banner must wrap rather than overflow at 320 CSS pixels and at 200%
  zoom, matching the constraint already documented on `.site-nav` in
  `+layout.svelte`.

**Theme tokens:** `src/lib/themes/parchment-light.css` and
`src/lib/themes/worm-dark.css` currently define only `--parchment`,
`--surface`, `--ink`, `--ink-soft`, and `--accent`. There is no warning
colour. This design adds an `--alert` / `--alert-ink` pair to **both** theme
files rather than hardcoding an amber, so the banner follows the theme toggle
and stays consistent with the project's oklch token convention. Both pairs
must meet WCAG AA contrast for body text.

### 7. Error page — `src/routes/+error.svelte`

The repository has no `+error.svelte`, so every 404 and 500 currently renders
SvelteKit's unstyled default — the page a beta tester is most likely to hit
and screenshot. The new page shows the status and message, links to `/` and
`/characters`, and includes the feedback link when configured. It reuses the
layout's existing styling conventions.

### 8. Backup and recovery

The banner promises that data loss may occur; this section makes the response
to that a known procedure rather than an assumption.

- Confirm Cloudflare D1 Time Travel is active for the production database.
- Record `wrangler d1 time-travel info` and `wrangler d1 time-travel restore`
  in `DEPLOY.md`, with the environment-qualified commands actually used.
- Take a literal snapshot before the beta opens:
  `wrangler d1 export guild-book-db --remote --output <file>`.
- **Rehearse the restore once against a scratch database.** An unrehearsed
  restore is not a backup.

No production database is restored, overwritten, or recreated as part of this
work.

## Data flow

**Activity write.** Authenticated request → Auth.js `jwt` callback → widened
`users` select → `activityPatch(…)` → `null` (no write, the common case) or an
`update` on `users`, wrapped so failure cannot invalidate the token.

**Admin read.** `GET /admin` → `requireAdmin` (session → `users.email` →
`ADMIN_EMAILS` set) → 404 or → aggregate + paginated selects → page render.

**Banner.** Root layout renders it server-side, visible. On mount, the
component reads `sessionStorage`; if the dismissal key is present it hides.
Dismiss click writes the key and hides.

## Error handling

| Failure | Behaviour |
| --- | --- |
| Activity write throws | Caught, warned, ignored. Token stays valid; the user is not signed out. |
| `ADMIN_EMAILS` unset or empty | Empty set. `/admin` 404s for everyone, including the owner. Fail closed. |
| Session email is an admin address but the `users` row is not | 404. The DB column is authoritative. |
| Admin query throws | Load throws; the new `+error.svelte` renders. |
| Unrecognised sort or page param | Falls back to the default order and page 1; no error. |
| `FEEDBACK_URL` unset | Feedback link is not rendered. Banner and error page are otherwise unchanged. |
| `sessionStorage` unavailable (private mode, blocked) | Banner stays visible and dismissal is a no-op. Never throws. |

## Testing

**Unit**

- `tests/unit/admin-activity.test.ts` — same-UTC-day resume returns `null`;
  a day boundary crossing returns a patch; `loginCount` increments on sign-in
  only; `firstSeenAt` is set once and never rewritten; a null `lastSeenAt`
  (pre-migration row) produces a patch.
- `tests/unit/admin-config.test.ts` — unset env yields an empty set; casing
  and surrounding whitespace normalise; a null or empty email never matches;
  a partial-substring email never matches.

**Integration**

- `tests/integration/admin-access.test.ts` — anonymous → 404; signed-in
  non-admin → 404; admin → 200 with the expected aggregate figures; **a JWT
  carrying an admin email whose `users` row carries a different address →
  404**; pagination and sort params clamp rather than error.

**E2E**

- `tests/e2e/alpha-banner.spec.ts` — banner present on load; dismiss hides it;
  it remains hidden across navigation within the session; a fresh browser
  context shows it again; it is present on a public `/s/[shareId]` page; it
  does not cause horizontal overflow at 320px.

## Build sequence

1. **Banner, theme tokens, and error page.** No migration, no schema change —
   shippable on its own.
2. **Migration and activity tracking.** Must be deployed **before** the beta
   opens; the data does not exist retroactively.
3. **Admin gate and `/admin` page.**
4. **Backup documentation and the restore rehearsal.**

## Out of scope

- Every Increment 5 enablement task, including the Cloudflare rate-limit
  binding and the per-isolate limiter gap described above.
- The Pages → Workers migration
  (`docs/superpowers/plans/2026-07-27-cloudflare-workers-migration.md`).
- Charts or time series on `/admin`; the tables and tiles are the whole of the
  analytics.
- Any admin *write* capability — no editing, deleting, impersonating, or
  messaging users. The page is strictly read-only.
- A login event log, per-page analytics, or any third-party analytics service.
- Enabling campaigns for beta users.
