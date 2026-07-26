# Campaigns Increment 4 — Completion Record

In-session procedure completion, atomic character-resource integration, public
history, corrections, active-session departure cleanup, archival behavior, and
release-candidate accessibility.

## Release-candidate gate

Every command run on `worktree-campaigns-increment-4` at completion:

| Command | Result |
| --- | --- |
| `npm run content:verify` | 173 fields / 9 collections, 57 rules, 40 spells, 31 procedures, 14 tables (194 rows) — **0 drifted**; digest `e0c9fa9d5f70…` |
| `npx vitest run tests/unit/session --coverage` | 558 tests; **`src/lib/engine/session` 96.42% stmts / 93.65% branch / 100% funcs / 98.44% lines** |
| `npm test` (full `vitest run`) | **1146 passed**, 9 skipped, 87 files |
| `npm run check` | 4915 files, **0 errors, 0 warnings** |
| `npx playwright test` (full suite) | **49 passed** |
| `ADAPTER=cloudflare npm run build` | **clean** |

The engine coverage target (90%+) is met. `content:verify` requires the
gitignored `assets-src/HMTW_md` vault; it was copied in from the primary
worktree for the check and removed afterwards. `content:verify:ci` (the
vault-free variant) also passes: 86 tests.

The seven named Task 7 specs: `campaign-tests-of-fate`, `camp-procedures`,
`exploration-tarot`, `session-history`, `campaign-departure`,
`campaign-accessibility`, `campaign-mobile` — 9 tests, all passing.

## Audit-ID → test mapping

Every `supported-v1` procedure in `docs/rules/tarot-procedure-audit.md` maps to
a named test or a documented exclusion.

| Audit id | Where it runs | Named test |
| --- | --- | --- |
| `test-of-fate` | `procedures/test-of-fate.ts` | `tests/unit/session/procedures/test-of-fate.test.ts` (23 tests) |
| `group-test` | `procedures/group-test.ts` | `tests/unit/session/procedures/group-test.test.ts` (22 tests) |
| `challenge-round` + 7 `challenge-*` modifiers | `procedures/challenge/*` | Increment 3 suites (`tests/unit/session/challenge/*`) |
| `camp-high-chant` | `procedures/camp.ts` | `camp.test.ts` — "High Chant selection", "distribution and privacy" |
| `camp-leeches` | `procedures/camp.ts` | `camp.test.ts` — "leeches" (9 tests) |
| `camp-watch` | finite runner | `crawl.test.ts` — "Camp watch — a random encounter…", "…skips the watch steps" |
| `camp-patrol` | finite runner | `crawl.test.ts` — "Patrol — two draws…", "Patrol — two encounters…" |
| `overland-travel` | finite runner | `crawl.test.ts` — "Overland Travel" |
| `crawl-area-sense` | finite runner | `crawl.test.ts` — "Crawl Area Sense" |
| `crawl-were-doomed` | finite runner | `crawl.test.ts` — "We're Doomed" |
| `test-augury` | finite runner | `oracles.test.ts` — "Test Augury" (accept + decline) |
| `oracle-maleficence` | finite runner | `oracles.test.ts` — "Maleficence" (both invocation modes) |
| `oracle-malediction` | finite runner | `oracles.test.ts` — "Malediction" + "flat 50% manual branch" |
| `oracle-random-totem` | finite runner | `oracles.test.ts` — "Random Totem" |
| `gm-twist` | finite runner | `oracles.test.ts` — "GM twist" (+ empty-discard rejection) |
| `denizen-disposition` | finite runner | `oracles.test.ts` — "Disposition" |
| `city-doomsaying` | finite runner | `oracles.test.ts` — "City Doomsaying" |
| `city-strange-communions` | finite runner | `oracles.test.ts` — "Strange Communions" |
| `city-as-above-so-below` | finite runner | `oracles.test.ts` — "As Above, So Below" |
| `city-events`, `city-signs-and-portents`, `city-carouse`, `city-beg-and-busk` | finite runner (generic; same step shapes) | `lookup.test.ts` covers their tables (`city-events`, `signs-and-portents`, `hangover` incl. every token form) |
| `crawl-meatgrinder` | **excluded from the runner** | `finite-procedure.ts`'s `UNSUPPORTED_PROCEDURE_IDS` — its steps are alternative *entry modes* (ordinary room / moving carefully / loud noise / questing beast oil), not a sequence; a sequential runner would execute all four. Its actual card operation is one major draw against the `meatgrinder` table, which is exactly `overland-travel`'s shape and IS covered. |

`resolveLookup` is separately covered across all three axes and every token
form by `tests/unit/session/lookup.test.ts` (18 tests).

## Resolve race evidence

`tests/integration/session-resolve.test.ts` (12) and
`tests/integration/guided-test-command.test.ts` (14):

- success advances character version 1→2 and `resolve.current` 3→2, with
  `character_version_claims.mutation_kind = 'session-resolve'`;
- an unrelated sheet edit that moved the version is **preserved** (the
  reread reapplies; `appearance: 'a new scar'` survives the spend);
- a moved Resolve value returns `content-mismatch` with the current numbers
  and persists **nothing** — no command row, no session version bump — so the
  reconfirmed retry may reuse its `commandId`;
- an envelope carrying a character document, or the pair on a non-spending
  command, or a purchase omitting the pair: all refused before any read.

Proven non-vacuous by mutation: removing the atomic statement splice fails 2
tests.

## Private-state purge proof

`tests/integration/session-history.test.ts`. A fixture session ends holding a
public played card, a private hand card, a prepared card, a server draw order,
and recipient event secrets. After `endSession`:

- serialized history **contains** the public card id;
- **does not contain** the private hand card, the prepared card, or the server
  draw order;
- `session_private_states` for the session: **0 rows**;
- `campaign_event_secrets` for the session: **0 rows**;
- `session_server_states.server_state_json` = `'{}'`;
- the checksum recomputes from the served history and changes when any event is
  dropped — **corruption detection, explicitly not a signature**.

## Member-cleanup failure matrix

`tests/integration/session-member-cleanup.test.ts` (6 tests):

| Scenario | Result |
| --- | --- |
| Player leaves mid-session holding 3 cards | All 3 returned to the draw pile, pile **shuffled** (returned cards are not the last 3), membership revoked, tenure ended, private state + secrets deleted, count-only public event, actor no longer resolves |
| GM removes a member holding 2 cards | Identical cleanup, `reason: 'removed'`, `removed_at` stamped |
| Injected statement failure (trigger ABORT on `session_server_states` UPDATE) | **Nothing moved**: membership live, tenure live, hand intact, session version unchanged — and the departure succeeds once the fault clears |
| Departure with no open session | No session cleanup at all; zero `session-participant-removed` events |
| Bystander during another's departure | Own private state and actor resolution untouched |
| Archive with active session / frozen session / ended session | `session-active` / `session-active` / `ok` |

## Accessibility report

`tests/e2e/campaign-accessibility.spec.ts` and `campaign-mobile.spec.ts`,
implemented as Playwright role/name assertions. `@axe-core/playwright` was
**not** added as a dev dependency (never approved); the project's chosen
external audit runs in CI per the plan's Step 1 allowance.

Verified:

- keyboard-only operation — the draw control takes focus and activates on
  `Enter`;
- every card is exposed as `role="img"` with an accessible name; interactive
  card controls are real `<button>`s whose names carry the card and its
  position (`Card 1 of 1: X of Cups`, `Play X of Cups`, `Discard X of Cups`);
- **a card back's accessible name is exactly `Face-down card`**, and the hidden
  identity appears nowhere in another player's or the GM's rendered document —
  not in `aria-label`, `title`, a data attribute, or offscreen text;
- focus is retained across the ~1s polling cycle (asserted after 2+ cycles);
- live announcements use `role="status"` + `aria-live="polite"`;
- mobile at 320 CSS px: real DOM order is table-first, drawers are native
  `<details>` operable by `Enter` with focus retained on the summary, and the
  hand scrolls inside its own container;
- **no two-dimensional page overflow** at 320 px or at 200% zoom.

### Two real bugs the accessibility work found

1. **The site nav did not wrap.** `.site-nav` was an unwrapped flex row, so at
   320 CSS pixels (and at 200% zoom) the whole document scrolled sideways on
   *every page*, not just the table. Fixed with `flex-wrap: wrap`.
2. **`aria-label` on a plain `<div>` was not exposed.** `TarotCard` labelled
   three `<div>`s without a role, so assistive technology had no accessible
   name for any card. Fixed with `role="img"`.

Both are pre-existing and outside the campaign feature; both were fixed here
because the RC gate is where they surfaced.

## Mobile screenshots

Not captured. The mobile behavior is asserted programmatically instead
(computed DOM order, `open` attribute transitions, focus assertions, and
measured `scrollWidth - clientWidth`), which is what the gate can verify
repeatably in CI; a screenshot would document appearance without proving the
overflow rule. Flagged rather than silently dropped.

## Deferred, as the plan intends

Job Board, dungeon/city generators, GM prep oracles, and full VTT tools remain
out of scope. Public enablement still waits for artwork and Increment 5 — the
feature stays behind `CAMPAIGNS_ENABLED` / pilot user ids.
