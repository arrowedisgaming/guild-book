# Full Chapters 1–9 Rules Coverage + Site-Wide Fuzzy Search — Design

Date: 2026-08-01 (revised same day after external review)
Status: Approved direction; revision pending user re-review

## Goal

1. The `/rules` reference fully represents His Majesty the Worm chapters 1–9
   under the content guarantee defined below.
2. A text/fuzzy search over that rules text is available from every page that
   uses the root layout, as an always-visible header input with a ranked
   results dropdown.

## Decisions made during brainstorming and review

- **Coverage**: every H1/H2 section of chapters 1–9, under the "everything"
  preservation semantics below. Chapter 10 and the appendices keep their
  current curated excerpts (7 entries: 1 `gamemastering`, 6 `appendix-sorcery`);
  expanding them is out of scope. Of the current 57 entries, the 50 that fall
  inside chapters 1–9 are superseded by walk output (under their legacy ids).
- **Licensing**: reproduction proceeds under the Adherent of the Worm open
  licence ("the mechanics and game text of His Majesty the Worm may be reused
  freely" — already cited by `index.json` and `/licensing`) plus direct
  permission from Joshua McCrowell for full-chapter reproduction. No sign-in
  gating; rules stay public static content. See "Legal updates."
- **Search scope**: rule entries only (chapters 1–9 plus the 7 curated
  entries). Standalone collections (denizens, spells, items, talents,
  conditions) are not indexed — prose *about* those topics inside chapters 1–9
  is, because it is rules text.
- **Search UI**: always-visible header input on every root-layout page, ranked
  dropdown, client-side MiniSearch over a lazy-loaded static artifact.

## Content guarantee

The guarantee is **"all source prose, wording preserved"**, not byte-for-byte
verbatim. For every emitted entry:

- **Included**: rules prose, worked examples ("Example …" subsections),
  sidebars/callouts (converted to headed sub-sections via the existing
  `convertCallouts` path, now the default for walked entries), and chapter/
  section epigraphs (H5/H6 quotations, rendered as an italicized quotation
  paragraph with its attribution — the app renderer has no blockquote support).
- **Preserved wording for cross-references**: wikilinks flatten to their label
  text and pointer sentences/clauses are **kept**, not deleted. The walk path
  uses a gentler variant of `stripWikilinks` that drops only bare page-number
  references. (The existing aggressive clause-stripping remains for the
  curated excerpt path only.)
- **Permitted omissions** (each class documented in the importer): bare page
  numbers ("p. 137"), image placeholders/suit-glyph alt text, running page
  headers baked into the export, and export artifacts repaired via `omitRange`
  (which requires a rationale string in the manifest).
- **Transformation classes**: every transformation in the walk path is
  classified in code comments as (a) lossless markup normalization, (b)
  intentional artifact repair, or (c) permitted omission per the list above.
  Nothing else may alter wording.

`lintBody` continues to gate every entry (wikilink leakage, PLACEHOLDER, bare
page references, suit glyphs, inline heading markers, sentinels). The
`challenge-facedown-cards` privacy-rule sentinel keeps passing naturally since
callout conversion is now the walk default.

## Part 1 — Content pipeline

### Chapter-walk manifest entries

`scripts/content-import/manifest/rules-md.json` gains a walk entry kind
alongside the excerpt kind (retained for the 7 non-chapter-1–9 entries):

```json
{
  "walk": {
    "file": "07 - Chapter 7 - The Challenge Phase.md",
    "section": "challenge-phase",
    "idAliases": { "challenge-flow/draw-challenge-cards": "challenge-draw-cards" },
    "splitDeeper": [
      { "at": "The Flow of the Challenge Phase/3. Take turns/Action value", "id": "challenge-action-value" },
      { "at": "GMing the Challenge/3. Enemy actions/Lesser dooms", "id": "challenge-lesser-dooms" }
    ],
    "ids": { "GMing the Challenge/1. Draw Challenge cards": "challenge-gm-hand-size" },
    "overrides": { "challenge-guard": { "title": "Guard" } }
  }
}
```

- One walk entry per chapter file, 01–09, mapped to the existing section slugs
  (`basics` … `city-phase`); no `sections.ts` taxonomy change.
- **Structural locators, not bare strings**: every manifest reference to a
  heading uses `parent-path/heading` plus an `occurrence` index where a path
  still repeats. Chapter 7's duplicated flow headings (`0. Set the scene`,
  `1. Draw Challenge cards`, `4. Minor actions`, `5. End the round` under both
  the player flow and "GMing the Challenge") are distinct rules and resolve to
  distinct hierarchy-derived ids.
- `skip` entries use the same structural locators and require a `reason`
  string. Under the "everything" guarantee, valid skips are export junk only —
  e.g. Chapter 2's duplicated all-caps `NEW ADVENTURER CHECKLIST` copy — never
  examples, sidebars, or epigraphs.

### Walker ownership model (no duplicated content)

The chapter is parsed into a heading tree. Ownership:

- An **H1 entry** owns only the prose before its first H2 child.
- An **H2 entry** owns content until the next H1 or H2.
- **H3+ headings stay inline** in their owning entry's body, except headings
  listed in `splitDeeper`, which become standalone entries (and are excluded
  from the parent's body). `splitDeeper` exists because live consumers cite
  H3-level ids: `index.json`'s `doomTiers` references
  `challenge-lesser-dooms`/`challenge-greater-dooms`, both H3s under
  "3. Enemy actions".
- An H1 with no directly-owned prose is recorded as a **container** in the
  coverage ledger and emitted as nothing; its H2 children carry the content.
- Test: for a fixture with H1 intro + two H2 children, every source paragraph
  appears in exactly one emitted body.

Expected yield: ~130–170 entries.

### Identity, collisions, aliases

- Ids: `<section>-<slug>`; slug from heading text, lowercased, ordinal junk
  stripped (`## 8 - Conditions` → `conditions`, `## 9 -Resolve` → `resolve`),
  apostrophes/punctuation dropped.
- **A within-section slug collision is a build error**, not a warning, until
  the manifest resolves it with an explicit id (`ids` map, keyed by structural
  locator). No automatic `-2` suffixes — they are insertion-order-dependent
  and unfit for permanent URLs.
- `idAliases` maps structural locators to legacy ids so the 50 superseded
  curated entries keep their exact current ids (`the-four-phases`,
  `tests-of-fate`, etc. — legacy ids mostly lack section prefixes). Alias
  validation is bijective: each emitted entry claims at most one alias, no two
  entries may claim the same one, and every alias must correspond to a
  previously-committed id.
- **Id-consumer audit** is part of implementation: all ids referenced by
  `tarot-procedures-md.json` (`ruleEntryIds`), `index.json`
  (`doomTiers.*.ruleEntryId`), unit tests (`rules-coverage.test.ts` pins
  specific ids), and internal links must resolve against the new output; a
  test asserts every such reference resolves.

### Tags

Tags become **optional metadata**: walked entries emit `tags: []` unless an
override supplies them; curated entries keep theirs. The
`rules-coverage.test.ts` "at least one tag" assertion is relaxed to "tags
array present". `RuleArticle` already renders nothing for an empty list.
Search does not index tags.

### Coverage ledger (CI-verifiable completeness)

CI has no vault (it is gitignored), and `content:verify:ci` never runs
`md-rules.mjs --check` — so source coverage must be provable from committed
artifacts:

- The build emits `scripts/content-import/manifest/rules-coverage-ledger.json`
  (committed): per chapter file — source SHA-256, and the ordered list of
  every H1/H2 (plus `splitDeeper` H3s) with level, structural locator,
  occurrence, and disposition (`emitted:<id>` | `container` | `skipped` with
  reason).
- **Local** (`content:verify`): regenerate the ledger from the vault and diff;
  any source edit, new heading, or unaccounted heading fails.
- **CI** (`content:verify:ci` test suite): without the vault, verify
  ledger↔`rules.json` consistency — every `emitted` id exists exactly once in
  `rules.json`, every `rules.json` chapter-section entry is claimed by the
  ledger, every skip carries a reason. CI thus proves committed-artifact
  integrity and ledger consistency; **source completeness is a local/release
  check** (per `release:verify`'s existing local flow), and the spec makes
  that distinction explicit.

### Search artifact — inside the pack contract

The build emits `static/content-packs/hmtw/rules-search.json`:

```json
[{ "id": "…", "section": "…", "title": "…", "headings": ["…"], "body": "…" }]
```

- `body` is plain text (markdown stripped, tables flattened); `headings` are
  the entry's inline H3+ headings. **No `sectionLabel`** — labels resolve
  client-side via `sections.ts`, keeping one source of truth.
- Contract: `rulesSearch?: string` added to `ContentPackFiles` (type + Zod
  schema), declared in `index.json.files` — which automatically brings it
  under the `contentDigest` integrity hash and the version-bump enforcement.
  The generated-files test is updated and the pack version bumped.
- A Zod schema for search documents validates the artifact in tests (the
  browser fetch path trusts the digest-verified static file).

## Part 2 — Site-wide search

### Header layout (real change, current header does not wrap)

`.site-header` is currently a non-wrapping flexbox; `.site-nav` wraps
internally. The header becomes a grid:

- Wide: `grid-template-columns: auto minmax(10rem, 14rem) 1fr` — brand,
  search, nav (nav right-aligned, still internally wrapping).
- Narrow breakpoint: brand + nav share the first row; the search takes
  `grid-column: 1 / -1` as a full-width second row.
- `min-width: 0` on the search cell; dropdown width constrained to the
  viewport (`max-width: calc(100vw - 2 * page padding)`).
- Acceptance: no horizontal overflow at 320 CSS px and 200% zoom, tested in
  both signed-in (7 nav items) and signed-out (4 items) states.

### Engine and service

- **MiniSearch**, dynamically imported on first use so no page pays for it
  until search is touched. Data artifact fetched lazily on first focus.
- `src/lib/search/rules-search.ts` service owns the lifecycle: one memoized
  initialization promise shared by all consumers (header + `/rules` page);
  concurrent callers never double-fetch/build; a failed init clears the memo
  so the next interaction retries; fetch URL carries the pack version as a
  cache-busting query (`?v=<pack version>`) for deploy coherence.
- Index config: fields `title` (boost 4), `headings` (boost 2), `body`;
  `prefix: true`, `fuzzy: 0.2`; tokenizer folds case and straight/curly
  apostrophes (`death's` ≡ `deaths`).
- **Ranking semantics** (explicit): multi-term queries combine with AND;
  exact-title match gets a large bonus; ties break by book order (stable
  entry index in the artifact); minimum query length 2 (shorter shows a hint,
  no results). `sectionLabel`/tags are not indexed.
- **Highlighting** uses the engine's matched terms (from MiniSearch match
  metadata), not the raw query — a fuzzy hit for "challnge" highlights
  "challenge". Snippets are built as text-node fragments around `<mark>`
  elements; **no `{@html}`** anywhere near query-derived strings. Sentence
  segmentation via `Intl.Segmenter` where available with a regex fallback
  (both under test).

### Dropdown UX and accessibility

- Ranked results (top ~15 in a viewport-constrained, scrollable listbox):
  title, chapter breadcrumb (label via `sections.ts`), snippet with
  highlights. Final row links to `/rules?q=<query>`.
- States: loading ("loading the rulebook…"), empty query (hint), no results,
  fetch-failed ("search unavailable — browse the rules index" linking to
  `/rules`; retry on next focus). The input never breaks a page.
- Keyboard: `/` focuses search globally (ignored with modifiers, while typing
  in inputs/textareas/contenteditable, or when a dialog is open); ArrowUp/Down
  move the active option with scroll-into-view; Enter navigates; Esc closes
  then blurs.
- Combobox contract: `role="combobox"`, `aria-expanded`, `aria-controls`,
  `aria-autocomplete="list"`, `role="listbox"`/`role="option"` with stable
  option ids for `aria-activedescendant`; pointer/touch selection; outside
  click and focus-leave close the dropdown; SvelteKit `afterNavigate` closes
  stale state; IME composition events do not trigger navigation on Enter;
  visually-hidden live region announces result counts.
- Result navigation goes to `/rules/[section]#entry-id`; after navigation the
  target article receives programmatic focus (tabindex="-1") so keyboard and
  screen-reader context move with it, plus a brief highlight that respects
  `prefers-reduced-motion`.

### `/rules` index page — two modes

- **Empty query**: today's grouped TOC, all nine chapters in book order, full
  entry lists. New enhancement: each chapter group shows its entry count.
  Lede text updated to describe full chapters 1–9 coverage.
- **Non-empty query** (typed locally or arriving via `?q=` from the header):
  a flat ranked result list — breadcrumb + snippet per hit — using the same
  service, so ordering matches the header dropdown exactly. Clearing the
  query returns to the grouped TOC.
- Fallback while the index loads or if it fails: substring filter over the
  SSR TOC (titles/tags), labeled as such.

### Performance budgets (acceptance criteria, not estimates)

- Record uncompressed and gzip sizes of `rules-search.json` at build time;
  budget ≤ 700KB raw / ≤ 200KB compressed. If exceeded, trim stored fields
  (snippets can be windowed) before considering a pre-serialized index.
- Index build time budgeted at ≤ 250ms on a mid-tier mobile profile
  (measured once during implementation with CPU throttling; not a CI gate).
- Measure actual HTML response sizes of the two largest section pages
  (`challenge-phase`, `city-phase`) after implementation; if a page exceeds
  ~150KB of HTML, split the section page by H1 groups rather than shipping
  everything (decision recorded then, not now).
- MiniSearch itself stays out of the initial bundle (dynamic import verified
  via build output).

## Error handling

- **Pipeline**: throw on lint problems, empty walks, unresolved collisions,
  bad locators, non-bijective aliases, unaccounted headings, or ledger drift.
  CI verifies committed-artifact integrity (digest) + ledger consistency.
- **Search**: failed artifact fetch → inline unavailable state with `/rules`
  link, memo cleared for retry; `/rules` degrades to substring-over-TOC.

## Testing

- **Vitest (pipeline)**: heading-tree ownership (H1 intro + H2 children →
  every paragraph exactly once), container handling, `splitDeeper`
  extraction, id normalization/ordinal stripping, collision → error,
  structural-locator resolution incl. `occurrence`, bijective alias
  validation, ledger generation + consistency check, gentler wikilink variant
  (pointer sentences kept, page numbers dropped), epigraph conversion,
  markdown-stripping for search docs, search-doc Zod schema, artifact under
  digest, all existing `ruleEntryIds`/`doomTiers` references resolve.
- **Vitest (search)**: ranking fixtures over the real corpus with expected
  top results; typo, prefix, apostrophe (straight + curly), and multi-term
  AND queries; a fuzzy match whose highlight differs from the typed spelling;
  tie-break by book order; min-length behavior; service memoization (single
  fetch under concurrent init), failed-fetch retry; `Intl.Segmenter` fallback.
- **Component**: combobox ARIA attributes, keyboard nav + scroll management,
  pointer selection, outside-click close, IME composition guard,
  reduced-motion highlight, text-node (no `{@html}`) snippet rendering.
- **Playwright**: header search from a non-rules page → typo'd known phrase →
  Enter lands on correct `/rules/[section]#id` with focused/highlighted
  article; `/` shortcut; `/rules?q=` handoff renders ranked mode; clearing
  returns grouped TOC; signed-in and signed-out headers at 320px/200% zoom
  with no horizontal overflow.

## Legal updates

- The pack already reproduces game text under the Adherent of the Worm open
  licence (cited in `index.json` and `/licensing`). Full-chapter reproduction
  additionally rests on direct permission from Joshua McCrowell.
- Update **both** CLAUDE.md and AGENTS.md Legal sections (they mirror each
  other): replace "No verbatim copyrighted rule text beyond what the licence
  allows" with a statement that verbatim game text is reproduced under the
  open licence, and that full-text reproduction of chapters 1–9 (including
  examples, sidebars, and epigraphs) proceeds with the creator's direct
  permission; artwork/logo/trade-dress restrictions unchanged.
- `/licensing` page: one added sentence recording the same, consistently with
  the licence citation already there. Evidence of permission is retained
  privately; the site carries only the accurate summary.
- `index.json` `description`/`license` fields stay accurate as-is (they
  already state verbatim reproduction under the licence).

## Out of scope

- Chapter 10 / appendices full coverage (7 curated entries remain).
- Indexing standalone collections (denizens, spells, items, talents,
  conditions) in search.
- Server-side search, search analytics, offline/PWA caching.
