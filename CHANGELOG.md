# Changelog

All notable changes to Guild Book will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
