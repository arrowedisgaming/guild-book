# Changelog

All notable changes to Guild Book will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/arrowedisgaming/guild-book/commits/main
