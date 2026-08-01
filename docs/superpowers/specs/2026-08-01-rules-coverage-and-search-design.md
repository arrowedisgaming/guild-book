# Full Chapters 1–9 Rules Coverage + Site-Wide Fuzzy Search — Design

Date: 2026-08-01
Status: Approved by Arrowed (brainstorming session)

## Goal

1. The `/rules` reference fully represents His Majesty the Worm chapters 1–9:
   every section of those chapters appears on the rules index with its complete
   verbatim body.
2. A really nice text/fuzzy search over that rules text is visible from nearly
   every page of the UI, as an always-visible header input with a ranked
   results dropdown.

## Decisions made during brainstorming

- **Coverage**: full verbatim text, every section of chapters 1–9. Chapter 10
  and the appendices keep their current curated excerpts; expanding them is out
  of scope.
- **Licensing**: Joshua McCrowell has granted permission for full-text
  reproduction. No sign-in gating anywhere; rules stay public static content.
  CLAUDE.md's Legal section and the `/licensing` page are updated to record the
  permission.
- **Search scope**: rules text only (chapters 1–9 entries plus whatever else is
  in `rules.json`). Denizens/spells/items are not indexed in this iteration.
- **Search UI**: always-visible header input on every page, ranked dropdown
  with snippets and highlighting. Approach: client-side MiniSearch over a
  lazy-loaded static index file.

## Part 1 — Content pipeline

### Chapter-walk manifest entries

`scripts/content-import/manifest/rules-md.json` gains a second entry kind.
Alongside today's excerpt entries, a **walk** entry describes a whole chapter:

```json
{
  "walk": {
    "file": "01 - Chapter 1 - The Basics.md",
    "section": "basics",
    "splitAt": 2,
    "idAliases": { "basics-the-four-phases": "the-four-phases" },
    "overrides": {
      "basics-adjudicating-the-game-gm-responses": {
        "omitRange": { "from": "…", "to": "…" }
      }
    }
  }
}
```

(Legacy curated ids mostly lack a section prefix — `the-four-phases`,
`tests-of-fate` — so chapter 1 in particular leans on `idAliases`. Chapter 2's
walk would use `skip: ["NEW ADVENTURER CHECKLIST"]` for its duplicated
all-caps heading, and a title override for `## 9 -Resolve`.)

- One walk entry per chapter file, 01–09, mapped to the existing section slugs
  (`basics`, `adventurer`, `guild`, `kith-and-kin`, `four-paths`,
  `crawl-phase`, `challenge-phase`, `camp-phase`, `city-phase`). No changes to
  `src/lib/content/sections.ts` are needed.
- The walker splits at H1 and H2 headings (`splitAt: 2`). Each heading becomes
  one `RuleEntry`; its body is everything below the heading down to the next
  heading of the same or higher level. H3+ headings remain inline in the body
  (RuleArticle already styles them). Expected yield: ~130–160 entries.
- A heading whose own body is empty because all content lives in its
  subsections (a pure container H1) is emitted only if it has intro prose;
  otherwise the walker drops it (its H2s carry the content) and records it as
  accounted-for, so the coverage assertion below still passes.

### Id and title normalization

- Ids: `<section>-<slug>` where the slug is the heading lowercased, ordinal
  junk stripped (`## 8 - Conditions` → `conditions`; `## 9 -Resolve` →
  `resolve`), apostrophes/punctuation dropped, spaces to hyphens.
- Titles: heading text with ordinal prefixes stripped and the book's stray
  formatting fixed via `overrides` (e.g. all-caps duplicates).
- Duplicate resulting ids within a chapter get `-2`, `-3` suffixes **and** a
  build warning so they are resolved deliberately via `skip`/`overrides`.
- `idAliases` maps a generated id to a legacy curated id so the walk emits the
  entry under the old id. All 57 existing ids that correspond to walked
  headings keep their current values; existing `/rules/[section]#id` links do
  not break. Excerpt manifest entries superseded by walk output are deleted.

### Overrides and lint

- Per-entry overrides carry the existing machinery keyed by generated id:
  `omitRange`, `keepCallouts`, `mustContain`, `mustNotContain`, plus `title`
  and `tags`. Walked entries get tags from overrides only (no auto-tagging).
- `skip` lists headings excluded from emission (junk/duplicated headings).
  Every H1/H2 in the source must be either emitted or explicitly skipped —
  anything else fails the build. This makes "fully represented" machine-checked.
- `lintBody` runs unchanged on every entry (wikilinks, PLACEHOLDER, page
  cross-references, suit-glyph tokens, inline heading markers). Any lint
  problem, zero-entry walk, unresolvable override/alias id, or cross-chapter
  duplicate id throws and fails the build.
- `--check` drift detection and CI usage are unchanged.

### Search index artifact

The same script emits a second file,
`static/content-packs/hmtw/rules-search.json`:

```json
[{ "id", "section", "sectionLabel", "title", "headings": ["…"], "body" }]
```

- `body` is plain text: markdown syntax stripped (headings, emphasis, lists,
  tables flattened to readable text) — used for indexing and snippets only.
- `headings` collects the entry's internal H3+ headings for boosted matching.
- `rules.json` remains the render source of truth; the search file is derived
  and covered by the same `--check` drift gate.

## Part 2 — Site-wide search

### Component

`src/lib/components/layout/SiteSearch.svelte`, rendered in
`src/routes/+layout.svelte`'s header on every page.

- Desktop: compact input (~14rem, grows on focus) between brand and nav.
- Narrow viewports: wraps to a full-width row (the header already flex-wraps;
  this follows the established responsive pattern; no horizontal overflow at
  320px / 200% zoom).

### Engine

- **MiniSearch** (new dependency, ~8KB, zero transitive deps).
- Fields: `title` (boost ≈ 4), `headings` (boost ≈ 2), `body`. Options:
  `prefix: true`, `fuzzy: 0.2`. Custom tokenizer folds case and apostrophes
  (straight and curly) so `death's` ≡ `deaths` — same folding as the Obsidian
  vault's Rules Search script, which this UI deliberately mirrors.
- Index is built client-side from `rules-search.json`, fetched lazily on first
  focus of the input, then cached for the session (module-level singleton).
  Nothing is fetched or built on pages where search is never touched.

### Dropdown UX

- Ranked results (top ~15): title, chapter breadcrumb (`sectionLabel`), and a
  snippet — first matching sentence with `<mark>` highlights.
- Final row links to `/rules?q=<query>` for a full-page result view.
- Loading state: "loading the rulebook…" while the index fetch is in flight.
- Keyboard: `/` focuses search globally (suppressed while typing in another
  input/textarea/contenteditable), ArrowUp/Down move selection, Enter
  navigates, Esc closes and blurs.
- Accessibility: combobox pattern (`role="combobox"`, `aria-expanded`,
  `role="listbox"` + `aria-activedescendant`), visually-hidden live region
  announcing result counts.
- Selecting a result navigates to `/rules/[section]#entry-id`. The section
  page applies a brief highlight animation to the `:target` article so the
  landing spot is obvious.

### `/rules` index page

- Grouped TOC keeps its current shape: all nine chapters in book order, full
  entry lists, entry count per chapter, existing multi-column grid.
- Lede text updated from "currently available Chapter 1 rules" to describe
  full chapters 1–9 coverage.
- The page's filter reuses the same MiniSearch index (reading `?q=` from the
  URL for the header handoff) instead of the current substring scan, so both
  surfaces rank identically. Fallback while the index loads (or if it fails):
  today's substring filter over the SSR TOC.
- `/rules/[section]` pages render more articles but stay well under 100KB of
  HTML; no pagination.

## Error handling

- **Pipeline**: throw on any lint problem, empty walk, bad override/alias id,
  or duplicate id (existing stance). CI `--check` catches committed drift.
- **Search**: failed `rules-search.json` fetch → dropdown shows "search
  unavailable — browse the rules index" linking to `/rules`; the input never
  breaks the page. `/rules` filter degrades to substring-over-TOC.

## Testing

- **Vitest**: heading walker (split levels, container-heading handling, id
  normalization, ordinal stripping, dedupe suffixing, alias mapping, skip
  accounting), markdown-stripping for search docs, and the coverage assertion
  (every source H1/H2 emitted or skipped).
- **Component**: SiteSearch keyboard navigation, ARIA attributes, and ranking
  smoke tests against a small fixture index.
- **Playwright**: header search from a non-rules page → known phrase → Enter
  lands on the correct `/rules/[section]#id` with highlight; `/` shortcut
  focuses the input; `/rules?q=` handoff pre-filters the index page.

## Legal updates

- CLAUDE.md Legal section: replace "No verbatim copyrighted rule text beyond
  what the licence allows" with a statement that Joshua McCrowell has granted
  permission for full-text reproduction of the rulebook text; artwork, logos,
  and trade-dress restrictions unchanged.
- `/licensing` page: add a matching sentence recording the permission.

## Out of scope

- Chapter 10 / appendices full coverage (current curated excerpts remain).
- Indexing denizens, spells, items, talents, conditions in search.
- Server-side search, search analytics, offline/PWA caching.
