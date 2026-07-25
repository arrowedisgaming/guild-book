# Changelog

All notable changes to Guild Book will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
