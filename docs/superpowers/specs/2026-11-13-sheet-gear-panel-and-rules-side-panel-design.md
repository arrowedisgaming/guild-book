# Sheet gear panel and rules side panel — design

Date: 2026-11-13
Status: awaiting approval

Two independent changes to the owner's sheet page (`/sheet/[id]`). Build Part 1
first; Part 2 does not depend on it.

## Why

The sheet is the play surface. Two things currently pull the player off it:

- **Gear.** Drawing a sword, stowing a torch or picking up loot means entering
  Edit mode, using a flat list in insertion order, and pressing Save. Slot usage
  is small text ("Belt 3/4"), so free space is easy to miss. Items not in the
  market catalogue cannot be added at all.
- **Rules.** The header search navigates to `/rules/...`, so looking something
  up means leaving the sheet.

## Goals

1. Gear is managed from the play view and saves automatically, like wounds.
2. In-hand and worn gear is always at the top; rows regroup the moment an item's
   location changes.
3. Open slots are obvious at a glance.
4. The player can add an item that is not in the catalogue.
5. On a wide screen, rules search, results and rule text sit beside the sheet.

## Non-goals

- Drag-and-drop between locations.
- Changing encumbrance rules, `autoPlace`, or the "capacity warns, never blocks"
  stance.
- Custom items as wound absorbers (wound options stay catalogue-driven).
- A rules panel on the campaign table, share page or any other page.
- Any change to the header search, `/rules` pages, the share page layout, or
  PDF/markdown layout (beyond showing custom durability, below).

## Anti-goals

- Reordering the stored `equipment` array. `wounds.ts` addresses entries by
  index; grouping is display-only.
- A gear change that is lost, or that clobbers a concurrent status save.
- Horizontal page scroll at any width, or any layout change below the wide
  breakpoint.

## Approaches

### Gear

- **A. One always-on Gear panel (chosen).** Gear leaves Edit mode and becomes a
  play panel next to Status. One component owns moving, quantities, notches,
  adding and removing.
- **B. Keep the Edit-mode list and add move controls to the read-only sheet.**
  Less work, but two gear UIs to keep in agreement, and add/remove still needs
  Edit mode.

A was picked because every gear action happens during play.

### Rules

- **A. Docked panel on the sheet page (chosen).** Two columns at wide widths;
  the panel has its own search, results and inline rule view.
- **B. Site-wide drawer** from the header search on every page. Broader layout
  change; risks the campaign table's responsive work.
- **C. Embed `/rules` in a frame.** Cheap, but double headers and nested
  scrolling.

A was picked for the smallest blast radius; the panel is a self-contained
component so the campaign table can adopt it later.

## Part 1 — Gear panel

### Placement and saving

- New `GearPanel.svelte` renders on `/sheet/[id]` at all times, directly below
  the Status and Experience panels, inside the same disabled-while-saving
  fieldset treatment as Status.
- It binds the page's working `char` and calls the same change handler as the
  Status panel (`onStatusChange`): debounced autosave outside Edit mode; inside
  Edit mode it joins the edit session and waits for Save changes / Cancel.
- `GearEdit.svelte` is removed from Edit mode (and deleted). 
  `SpellComponentsEdit` stays in Edit mode for creating and describing
  components; component entries also appear as rows in the Gear panel for
  move / quantity / remove.
- The read-only `CharacterSheet` on this page no longer shows its Gear section
  (new prop, default shows it). The share page keeps it unchanged.

### Layout

```
GEAR                                        [Auto-arrange]
IN HAND   ■ ■              full
  Longsword         1/3 notches   [Hand ▾]  − +  ✕
  Torch                           [Hand ▾]  − +  ✕
WORN
  Gambeson · 2 belt slots         [Worn ▾]       ✕
BELT      ■ ■ ■ □          1 open
  ...
BACKPACK  ■■■■■■■■■■■■□□□□□□□□□   9 open
  ...
[Add from market ▾] [Add]      [+ Custom item]
```

- Groups in fixed order: In hand, Worn, Belt, Backpack. All four always render,
  with an "empty" line when a group has no items, so open hands are visible.
- Within a group, rows keep stored-array order.
- Grouping is a derived view over `char.equipment`. Each row carries its
  original index for mutations. Changing the location select updates the entry
  in place; the row appears in its new group immediately. Keyboard focus follows
  the moved row's location select.
- Row controls are today's: location select (no Worn for spell components),
  quantity − / +, notches − / + when the item has durability, remove,
  "Destroyed" badge. Placement violations show under the header as today.

- Remove (✕) acts immediately with no confirmation, as removing an affliction or
  bond does in the Status panel. It now autosaves, so a misclick means re-adding
  the item.

### Open slots

- In hand, Belt and Backpack each show one box per slot of capacity, filled for
  used slots, outlined for open ones, followed by "N open" or "full".
- Over capacity: all boxes filled, accent colour, text "N over".
- Worn has no capacity. Worn armor shows "· N belt slots" on its row, and those
  slots are filled on the Belt's boxes (this is what `loadSummary` already
  reports).
- The boxes are decorative; each group header carries a text equivalent
  ("Belt: 3 of 4 slots used, 1 open") for screen readers.
- Numbers come from `loadSummary`; no new slot math.

### Adding items

- **From the market:** unchanged behaviour (full stack, lands in the pack).
- **Custom item:** "+ Custom item" opens an inline form:
  - Name — required, trimmed, 1–200 characters.
  - Slots — integer 0–21, default 1 (0 for trinkets).
  - Quantity — integer ≥ 1, default 1.
  - Tier — impoverished / common / luxurious, default common.
  - Max notches — optional integer 1–20; blank means no durability.
  - Creates `{ itemId: null, customName, tier, packSpace: slots, location:
    'pack', quantity, notchesTaken: 0, customNotches? }`.
- Custom items can go in any location. Worn custom items take no slots (same as
  clothing). Each unit takes `packSpace` slots (no stacking rule).

### Data change

- `EquipmentEntry` gains optional `customNotches?: number`. Zod: integer 1–20,
  only allowed when `itemId` is null and there is no `spellComponent`. Optional
  field, so no `schemaVersion` bump or migration.
- Durability everywhere becomes "catalogue `notches`, else `customNotches`":
  the Gear panel, `buildCharacterView` (and therefore the share page, PDF and
  markdown exports, which then show custom notches with no layout change).
- Zod also gains `customName` max 200 for non-component custom entries, to match
  the form. Existing data is unaffected (none exists outside components).

### Engine

- A pure helper in `src/lib/engine/` groups entries by location in display
  order, returning each with its original index, and a pure
  `createCustomItem(input)` validates and builds the entry. Both unit-tested.
  Everything else in `encumbrance.ts` is untouched.

## Part 2 — Rules side panel

### Layout

- At viewport width ≥ 80rem, `/sheet/[id]` becomes two columns: the sheet
  column (48rem, unchanged content) and a rules panel (about 24–28rem). The
  site container widens on this route only to make room; header and footer
  widen with it.
- The panel is sticky under the header, as tall as the viewport allows, and
  scrolls internally. The sheet scrolls with the page as today.
- Below 80rem the panel is not rendered at all and the page is exactly as
  today.

### Behaviour

- **Search view:** a search input and a results list (title, section,
  highlighted snippet) — the same engine, ranking and snippets as the header
  search (`getRulesSearch`, `buildSnippet`). Empty query shows a one-line hint.
  Loading, error and no-match states mirror the header search's wording.
- **Rule view:** choosing a result replaces the list with the full rule,
  rendered by the existing `RuleArticle`, with "← Results" at the top and
  "Open in rules ↗" (new tab, the normal `hitHref` link). The matched phrase is
  scrolled to and highlighted where the existing highlight helper allows.
- Full rule markdown is not in the search index (bodies there are plain text).
  The panel gets it from a new cacheable `GET /api/rules/[id]` returning one
  `RuleEntry` (resolving retired aliases, 404 otherwise).
- Links inside a rule that point at another rule (`/rules/<section>#<id>`) open
  in the panel; all other links behave normally.
- Keyboard: arrow keys / Enter in the results list as in the header search;
  Escape in the rule view returns to results. While the panel is shown, `/`
  focuses the panel's input instead of the header's.
- Panel state (query, open rule, scroll) survives sheet saves and Edit-mode
  toggles. It does not need to survive a reload or navigation.
- The header search is unchanged and still navigates to `/rules`.

### Structure

- `RulesSidePanel.svelte` under `src/lib/components/rules/`, taking only
  `packVersion`. Its state lives in a headless `.svelte.ts` module like
  `site-search.svelte.ts`, so keyboard and view-switching logic is unit-tested.
  No dependency on character data.

## Testing

- Unit: grouping helper, `createCustomItem`, schema rules for `customNotches`,
  view durability for custom items, panel state module, rules endpoint.
- E2E (Playwright): move an item belt → hand without Edit mode and see it
  regroup and persist after reload; add a custom item; slot text updates; wound
  flow still notches the right item after a regroup; at 1440px wide the panel
  shows, a search result opens in place and the sheet stays mounted; at 1024px
  no panel and no horizontal scroll.
- Existing `sheet-spell-components` and `encumbrance` tests keep passing.

## Left to the builder

- Exact visual styling of slot boxes, group headers and the custom-item form,
  within the existing parchment/ink/accent tokens.
- How the route signals the wider container to the root layout.
- Whether the Backpack's 21 boxes wrap or run in one row at narrow widths.
- Cache headers for the rules endpoint.
- CHANGELOG entry (Keep a Changelog) at implementation time.
