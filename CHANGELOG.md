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

[Unreleased]: https://github.com/arrowedisgaming/guild-book/commits/main
