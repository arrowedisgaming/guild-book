# HMTW content pack

This folder is the **single source of His Majesty the Worm game data** for Guild Book.
The app reads it through `src/lib/server/content/loader.ts`, validated by the Zod schemas
in `src/lib/schemas/`. **No rules are hardcoded in components or routes.**

## Status: verbatim, Markdown-sourced

Per the licence's own terms ("the mechanics and game text of His Majesty the Worm
may be reused freely"), all prose is **exact wording from the core rulebook**,
extracted by a script pipeline rather than retyped — diffable and re-runnable.

Every prose field is now derived from the book's clean per-chapter **Markdown
vault** at `assets-src/HMTW_md/` (gitignored, copyrighted): proper heading
structure, contiguous paragraphs, sidebars/quotes as `> [!callout]` blocks,
cross-refs as `[[wikilinks]]`, and preserved bold/italic. Descriptions render as
markdown through `Prose.svelte` (bold, italics, `-` lists, sub-headings).

- **Verbatim from Markdown:** `talents.json` (49), `items.json` (66 — the Omphalic
  Market), `kiths.json` (kith + kin descriptions and arête triggers), `paths.json`,
  `conditions.json`, `afflictions.json` (descriptions + staged effects),
  `languages.json`, `motifs.json` (the book's 50 descriptors + 50 professions —
  the earlier list was not the book's), `index.json` (attribute + tarot-outcome
  text), and `spells.json` (40 sorcery spells).
- **Partial / deferred:** `rules.json` — the browsable rules reference. Chapter 1
  (The Basics) is done as ten verbatim entries; the rest of the book's rules
  chapters are deferred. Entries carry an authored `section` (from the book's
  chapters — see `src/lib/content/sections.ts`), `title`, and `tags`.
- **Known source-export omission:** the damaged "A myth of the underfolk" fragment
  is deliberately excluded from the Underfolk description. The pipeline publishes
  only the complete, exact paragraphs that precede it rather than inventing text.
- **Transcribed directly (not pipeline-generated):** `denizens.json` (Appendix C:
  the six themes, five threats, and the full bestiary) reproduces the book text
  directly — the author has confirmed the full text is open content under the
  Adherent of the Worm licence, not just the mechanics.

### The pipeline

`scripts/content-import/` (Node ESM, no deps):

- `md-lib.mjs` — section extraction by heading + normalization (strips callouts,
  `## Example` sub-sections, wikilink cross-refs, HTML/suit-glyph artifacts;
  keeps bold/italic; reflows stray newlines).
- `md-inject.mjs` — fills the prose fields of the structured collections from
  `manifest/md/<packfile>.json` (each entry maps an id + field path to a chapter
  heading), preserving every mechanical field. `npm run content:inject`.
- `md-rules.mjs` / `md-spells.mjs` — build `rules.json` / `spells.json` from
  `manifest/rules-md.json` and the sorcery appendix.
- `npm run content:build` regenerates everything; `npm run content:verify`
  re-extracts and diffs exact normalized values against the committed pack,
  including Markdown emphasis.

Example-dialogue transcripts and setting flavor are excluded per the core-rules
scoping. `item.properties[]` is left as the project's structured mechanical tags
(not book prose); each item's full text is in its `description`. A few book
sections back several pack items (Armor → light/iron/steel, Clothes →
rags/common/finery, Shield → light/heavy, "Arrows and bolts" → arrows/bolts),
handled by `from`/`to` slice anchors in the manifest.

## Editing / extending

Keep the JSON shapes — they're defined by `src/lib/schemas/content-pack.schema.ts`.
Cross-file references that must stay valid (enforced by `tests/unit/content-pack.test.ts`):

- `kins[].masteredTalentId` / `kins[].areteTalentId` → a `talents.json` id
- `paths[].talentIds[]` (seven per path) → `talents.json` ids
- `talents[].requiredItemIds[]` → `items.json` ids
- `paths[].suit` and `attributes[].suit` → one of `swords|pentacles|cups|wands`

Item fields that drive the encumbrance engine: `slots`, `carry` (`belt-only` for
oversized gear, `hand` for wielded), `wornBeltSlots` (armor), `stack.per`
(units per slot), `notches` (durability).

Run `npm run test` after any edit — the schema round-trip and referential-integrity
tests reject a malformed pack before it reaches the UI.

## Legal

Published under the [Adherent of the Worm open licence](https://www.hismajestytheworm.games/open-license).
His Majesty the Worm is copyright Joshua McCrowell. No book artwork, logos, or trade
dress are reproduced; game text is reproduced verbatim per the licence. See `/licensing`
in the app.
