# Changelog

All notable changes to Guild Book will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-07-20

### Added

- **People in the denizen builder**: the Man theme now follows the book's
  "make actual characters" advice as an adversary path. Choosing it swaps the
  wizard to a Person step (replacing Threat): the adventurer 4/3/2/1 spread
  assigned by swap, an optional flavour-only kith recorded as a stat-block
  note, HD pre-filled for simplicity (with an optional switch to proper
  Wounds tracking and a note listing the book's wound options), and custom
  gimmick dooms instead of template pick-lists. Exports omit the threat line
  entirely for people. Switching between person and creature themes stashes
  and restores each side's work instead of discarding it.
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
