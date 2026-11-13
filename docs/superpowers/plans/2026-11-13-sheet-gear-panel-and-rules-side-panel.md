# Sheet Gear Panel and Rules Side Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make gear a play-time, autosaving panel on `/sheet/[id]` (grouped by location, visible open slots, custom items), and dock a rules search/reader beside the sheet on wide screens.

**Architecture:** Part 1 turns `GearEdit.svelte` into an always-on `GearPanel.svelte` driven by new pure helpers in `src/lib/engine/gear-view.ts`; it reuses the sheet page's existing debounced save path. Part 2 adds a headless panel-state module plus `RulesSidePanel.svelte`, fed by the existing client search engine and one new read-only endpoint for full rule text. Part 2 does not depend on Part 1.

**Tech Stack:** SvelteKit 2, Svelte 5 runes, TypeScript strict, Zod, Vitest (node env), Playwright.

**Spec:** `docs/superpowers/specs/2026-11-13-sheet-gear-panel-and-rules-side-panel-design.md`

## Global Constraints

- Never reorder or re-index `char.equipment`; grouping is display-only (`wounds.ts` addresses entries by array index).
- Do not change `slotsFor`, `loadSummary`, `autoPlace`, or the "capacity warns, never blocks" behaviour.
- Engine files (`src/lib/engine/`) stay pure: no `$app/`, `$lib/server/`, or UI imports.
- No layout change below a viewport of `80rem`; no horizontal page scroll at any width.
- Header search, `/rules` pages, share page (`/s/[shareId]`) and export layouts are unchanged.
- Svelte 5 runes conventions from `CLAUDE.md`; style with existing tokens (`--ink`, `--parchment`, `--accent`, `--font-*`).
- Work on a branch `feat/sheet-gear-and-rules-panel` (`main` is PR-only). No automated-authorship trailers in commits.
- One deliberate deviation from the spec: the Zod schema does **not** cap non-component `customName` at 200 (older sheets may hold longer free-typed gear and must stay saveable). The 200 limit is enforced by `createCustomItem` only.

## Review Focus

1. **Two quick gear changes inside one debounce window** — both must persist after reload (Task 3 e2e).
2. **Wound after a regroup** — notching via "Take a Wound…" must hit the same item it names, even when that item is displayed in a different position than its array index (Task 3 e2e).
3. **Edit-mode Cancel** — gear changes made while Edit mode is on must revert on Cancel and not autosave (Task 3 e2e).
4. **Bad custom-item input** — blank/whitespace name, 201-character name, fractional or negative slots, quantity 0, notches 21 must be rejected with a visible message and add nothing (Task 2 unit, Task 4 e2e).
5. **Rule that cannot be loaded** — unknown id or network failure in the panel shows an error with a working "Open in rules ↗" link and "← Results"; resizing below 80rem and back keeps the query and open rule (Task 6 unit, Task 7 e2e).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/engine/gear-view.ts` (new) | Pure: group entries for display, slot meter numbers/text, durability lookup, custom-item construction |
| `src/lib/types/character.ts`, `src/lib/schemas/character.schema.ts` | `customNotches` field |
| `src/lib/character/view.ts` | Durability falls back to `customNotches` |
| `src/lib/components/character/GearPanel.svelte` (moved from `edit/GearEdit.svelte`) | The play gear panel |
| `src/lib/components/character/CustomItemForm.svelte` (new) | Inline custom-item form |
| `src/lib/components/character/CharacterSheet.svelte` | `showGear` prop |
| `src/routes/api/rules/[id]/+server.ts` (new) | One rule's full markdown |
| `src/lib/components/rules/rules-side-panel.svelte.ts` (new) | Headless panel state |
| `src/lib/components/rules/RulesSidePanel.svelte` (new) | Panel UI |
| `src/lib/search/slash-target.svelte.ts` (new) | Lets the panel claim the `/` shortcut from `SiteSearch` |
| `src/routes/+layout.svelte`, `src/routes/sheet/[id]/+page.svelte` | Wide container, two columns, wiring |

---

## Part 1 — Gear panel

### Task 1: `customNotches` field and shared durability

**Files:**
- Create: `src/lib/engine/gear-view.ts`
- Modify: `src/lib/types/character.ts` (`EquipmentEntry`), `src/lib/schemas/character.schema.ts` (`equipmentEntrySchema`), `src/lib/character/view.ts:75`
- Test: `tests/unit/gear-view.test.ts` (new), `tests/unit/character-validation.test.ts`, `tests/unit/character-progress-view.test.ts`

**Interfaces:**
- Produces: `EquipmentEntry.customNotches?: number`; `durabilityOf(entry: EquipmentEntry, def: ItemDefinition | undefined): number | null` exported from `$lib/engine/gear-view`.

- [ ] **Step 1: Write failing tests**

`tests/unit/gear-view.test.ts` (reuse the `entry()` helper shape from `tests/unit/encumbrance.test.ts`; add `custom(overrides)` building `{ itemId: null, customName: 'Idol', tier: 'common', packSpace: 1, location: 'pack', quantity: 1, notchesTaken: 0, ...overrides }`):

```ts
describe('durabilityOf', () => {
	it('uses the catalogue notches', () => expect(durabilityOf(entry('helm'), items.get('helm'))).toBe(1));
	it('falls back to customNotches', () => expect(durabilityOf(custom({ customNotches: 3 }), undefined)).toBe(3));
	it('is null with neither', () => expect(durabilityOf(custom(), undefined)).toBeNull());
	it('catalogue wins over a stray customNotches', () =>
		expect(durabilityOf({ ...entry('helm'), customNotches: 9 }, items.get('helm'))).toBe(1));
});
```

Schema tests (in `character-validation.test.ts`, following its existing parse helper): a custom entry with `customNotches: 3` parses; `customNotches` of `0`, `21`, `1.5` fail; `customNotches` on an entry with a non-null `itemId` fails; `customNotches` on a spell-component entry fails; an existing custom entry with a 500-character `customName` and no `customNotches` still parses.

View test (in `character-progress-view.test.ts` or beside it): `buildCharacterView` of a character with `custom({ customNotches: 2, notchesTaken: 2 })` yields `durability: 2, destroyed: true`.

- [ ] **Step 2: Run** `npx vitest run tests/unit/gear-view.test.ts tests/unit/character-validation.test.ts tests/unit/character-progress-view.test.ts` — expect the new tests to FAIL.

- [ ] **Step 3: Implement**
  - `EquipmentEntry`: add `/** Durability of a custom (non-catalogue) item. */ customNotches?: number;`
  - Schema: `customNotches: z.number().int().min(1).max(20).optional()`; in the existing `superRefine`, before the `if (!entry.spellComponent) return;` early return, add an issue on path `['customNotches']` when `customNotches !== undefined && (itemId !== null || spellComponent)`.
  - `durabilityOf`: `def?.notches ?? entry.customNotches ?? null` (only consult `customNotches` when `def` is undefined or has no `notches`).
  - `view.ts`: replace `definition?.notches ?? null` with `durabilityOf(equipment, definition)`.

- [ ] **Step 4: Run** the same command plus `npm run check` — expect PASS.

- [ ] **Step 5: Commit** `feat(gear): custom-item durability field`

### Task 2: Grouping, slot meter, and custom-item construction

**Files:**
- Modify: `src/lib/engine/gear-view.ts`
- Test: `tests/unit/gear-view.test.ts`

**Interfaces:**
- Consumes: `LocationLoad` from `$lib/engine/encumbrance`.
- Produces:

```ts
export const GEAR_GROUPS: readonly { id: CarryLocation; label: string }[];
// exactly, in order: hand 'In hand', worn 'Worn', belt 'Belt', pack 'Backpack'
export interface GearRow { entry: EquipmentEntry; index: number } // index into the stored array
export interface GearGroup { id: CarryLocation; label: string; rows: GearRow[] }
export function groupGear(entries: EquipmentEntry[]): GearGroup[]; // always 4 groups

export interface SlotMeter { filled: number; open: number; over: number; status: string; text: string }
export function slotMeter(load: LocationLoad, label: string): SlotMeter;

export interface CustomItemInput {
	name: string; slots: number; quantity: number; tier: ItemTier; maxNotches: number | null;
}
export const CUSTOM_ITEM_LIMITS: { nameMax: 200; slotsMax: 21; notchesMax: 20 };
export function createCustomItem(input: CustomItemInput): EquipmentEntry; // throws Error(message)
```

- [ ] **Step 1: Write failing tests**

```ts
describe('groupGear', () => {
	it('always returns the four groups in order', () =>
		expect(groupGear([]).map((g) => g.label)).toEqual(['In hand', 'Worn', 'Belt', 'Backpack']));
	it('keeps stored order within a group and carries original indices', () => {
		const list = [entry('rope'), entry('weapon-dagger', { location: 'hand' }), entry('torch'), entry('helm', { location: 'worn' })];
		const g = groupGear(list);
		expect(g[0].rows.map((r) => r.index)).toEqual([1]);
		expect(g[1].rows.map((r) => r.index)).toEqual([3]);
		expect(g[3].rows.map((r) => r.index)).toEqual([0, 2]);
		expect(g[3].rows[0].entry).toBe(list[0]);
	});
	it('does not mutate its input', () => { const list = [entry('rope')]; groupGear(list); expect(list).toEqual([entry('rope')]); });
});

describe('slotMeter', () => {
	it('partly used', () => expect(slotMeter({ used: 3, capacity: 4, over: false }, 'Belt'))
		.toEqual({ filled: 3, open: 1, over: 0, status: '1 open', text: 'Belt: 3 of 4 slots used, 1 open' }));
	it('full', () => expect(slotMeter({ used: 2, capacity: 2, over: false }, 'In hand'))
		.toMatchObject({ filled: 2, open: 0, over: 0, status: 'full', text: 'In hand: 2 of 2 slots used, full' }));
	it('over', () => expect(slotMeter({ used: 23, capacity: 21, over: true }, 'Backpack'))
		.toMatchObject({ filled: 21, open: 0, over: 2, status: '2 over', text: 'Backpack: 23 of 21 slots used, 2 over' }));
});

describe('createCustomItem', () => {
	const ok = { name: '  Jade idol ', slots: 1, quantity: 1, tier: 'common' as const, maxNotches: null };
	it('builds a packed custom entry with a trimmed name', () =>
		expect(createCustomItem(ok)).toEqual({ itemId: null, customName: 'Jade idol', tier: 'common', packSpace: 1, location: 'pack', quantity: 1, notchesTaken: 0 }));
	it('includes customNotches only when given', () =>
		expect(createCustomItem({ ...ok, maxNotches: 3 }).customNotches).toBe(3));
	it('allows zero slots', () => expect(createCustomItem({ ...ok, slots: 0 }).packSpace).toBe(0));
	it.each([
		[{ name: '   ' }, /name/i], [{ name: 'x'.repeat(201) }, /200/],
		[{ slots: -1 }, /slots/i], [{ slots: 22 }, /slots/i], [{ slots: 1.5 }, /slots/i],
		[{ quantity: 0 }, /quantity/i], [{ quantity: 2.5 }, /quantity/i],
		[{ maxNotches: 0 }, /notches/i], [{ maxNotches: 21 }, /notches/i]
	])('rejects %o', (patch, message) => expect(() => createCustomItem({ ...ok, ...patch })).toThrow(message));
});
```

Also assert the built entry passes `equipmentEntrySchema` (export it from the schema file if it is not already exported) and that `slotsFor(createCustomItem({ ...ok, slots: 0 }), undefined)` is `0` and a `worn` custom entry is `0`.

- [ ] **Step 2: Run** `npx vitest run tests/unit/gear-view.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the three functions and constants in `gear-view.ts`. Error messages: "Give the item a name.", "Name must be 200 characters or fewer.", "Slots must be a whole number from 0 to 21.", "Quantity must be a whole number of 1 or more.", "Max notches must be a whole number from 1 to 20."
- [ ] **Step 4: Run** the test file — expect PASS.
- [ ] **Step 5: Commit** `feat(gear): display grouping, slot meter and custom-item builder`

### Task 3: GearPanel on the play view, autosaving

**Files:**
- Move: `src/lib/components/character/edit/GearEdit.svelte` → `src/lib/components/character/GearPanel.svelte` (`git mv`)
- Modify: `src/routes/sheet/[id]/+page.svelte`, `src/lib/components/character/CharacterSheet.svelte`
- Test: `tests/e2e/sheet-gear.spec.ts` (new); update any existing e2e that reaches gear through Edit mode (`sheet-spell-components.spec.ts` asserts component text after reload — it must still pass)

**Interfaces:**
- Consumes: `groupGear`, `GEAR_GROUPS`, `slotMeter`, `durabilityOf` (Tasks 1–2); `loadSummary`, `autoPlace`, `indexItems`.
- Produces: `GearPanel` props `{ char = $bindable(), items: ItemDefinition[], encumbrance: EncumbranceConfig, onChange: () => void }` (unchanged from `GearEdit`); `CharacterSheet` prop `showGear?: boolean` (default `true`). The panel root is `<section class="gear-panel" aria-labelledby="gear-heading">` with `<h2 id="gear-heading">Gear</h2>`; each group is `<section aria-label={meter.text ?? 'Worn'}>` with an `<h3>` label; each location select has `aria-label={`Location of ${name}`}`.

- [ ] **Step 1: Write failing e2e tests** in `tests/e2e/sheet-gear.spec.ts` using `signInAs` / `createTestAdventurer` from `./fixtures/auth`. Add gear through the panel's market select ("Add an item…" → option by item name → "Add"). Tests:
  1. *moves gear without Edit mode and persists*: add "Dagger"; without clicking Edit, set "Location of Dagger" to Hand; expect the Dagger row inside the region whose name starts "In hand"; the region name contains "1 open"; `page.reload()`; still there.
  2. *two quick changes both persist*: add "Dagger" and "Rope"; set Dagger → Hand and Rope → Belt back-to-back (no waits); wait for the PUT to settle (`page.waitForResponse` on `/api/characters/`), reload; both regrouped.
  3. *empty groups still render*: fresh adventurer shows headings In hand, Worn, Belt, Backpack and the In hand region name contains "2 open".
  4. *wound notches the item it names after a regroup*: add "Rope", then "Shield, Light", then "Helm"; move the shield to Hand; click "Take a Wound…", choose the option naming the shield; expect the shield row to read "notches 1/1" / Destroyed and Rope and Helm rows unchanged.
  5. *Edit-mode Cancel reverts gear*: click Edit; add "Torch"; Cancel; Torch absent; reload; still absent.
  6. *no Gear section duplicated*: outside Edit mode exactly one heading named "Gear" exists on the page.
  7. *narrow screen*: at 390×844 the page has no horizontal scroll (`scrollWidth <= innerWidth`) with a full backpack meter visible.

- [ ] **Step 2: Run** `npx playwright test tests/e2e/sheet-gear.spec.ts --trace off` — expect FAIL.

- [ ] **Step 3: Rework the component** (now `GearPanel.svelte`):
  - Header row: `h2` "Gear" and the existing Auto-arrange button. Drop the old text meters.
  - Render `groupGear(char.equipment)`; all mutations keep using `row.index`. `{#each}` rows keyed by `row.index`.
  - Group header: label, then for hand/belt/pack one `<span class="slot" class:filled>` per capacity slot (`aria-hidden="true"` on the box strip) and the meter's `status`; `over` state uses `--accent`. Worn has no boxes. Map group ids to `load.hands | load.belt | load.pack`.
  - Empty group shows a muted "empty" line.
  - Row: name, `×N`, Destroyed badge, location select (no Worn for spell components), qty − / +, notches − / + when `durabilityOf(...)` is non-null (max is that value), ✕ (no confirmation). Worn armor rows append "· N belt slots" from `def.wornBeltSlots`.
  - After a location change, move focus to that entry's select in its new group (`tick()` then focus by `data-entry-index`).
  - Violations list and the market add row stay as they are.

- [ ] **Step 4: Wire the page** (`src/routes/sheet/[id]/+page.svelte`):
  - Render `<GearPanel bind:char items={data.content.items} encumbrance={data.content.encumbrance} onChange={onStatusChange} />` in its own `<fieldset class="play-controls" disabled={saving || recordingXp || syncRequired}>` directly after `ExperiencePanel`, outside the `{#if editMode}` block. (`onStatusChange` already debounces outside Edit mode and defers to the edit session inside it.)
  - In the Edit-mode Gear section, remove `GearEdit`; keep `SpellComponentsEdit` and retitle that section's `h2` to "Spell components" (drop the component's own duplicate `h3` only if it reads redundantly).
  - `<CharacterSheet view={data.view} showGear={false} />`; in `CharacterSheet.svelte` add the prop and wrap the Gear section in `{#if showGear && view.equipment.length}`. The share page is not touched.

  Note on the disabled fieldset: it disables controls during each save round trip. If test 2 shows the second change being blocked or focus being dropped mid-interaction, do **not** remove the fieldset; make the test wait for the first control to re-enable instead, and report it in the task summary.

- [ ] **Step 5: Run** `npm run check`, `npm run test`, and `npx playwright test tests/e2e/sheet-gear.spec.ts tests/e2e/sheet-spell-components.spec.ts tests/e2e/sheet-navigation.spec.ts --trace off` — expect PASS.

- [ ] **Step 6: Commit** `feat(sheet): always-on gear panel with location groups and slot boxes`

### Task 4: Custom item form

**Files:**
- Create: `src/lib/components/character/CustomItemForm.svelte`
- Modify: `src/lib/components/character/GearPanel.svelte`
- Test: `tests/e2e/sheet-gear.spec.ts`

**Interfaces:**
- Consumes: `createCustomItem`, `CUSTOM_ITEM_LIMITS`, `CustomItemInput`.
- Produces: `CustomItemForm` props `{ onAdd: (entry: EquipmentEntry) => void; onCancel: () => void }`. Labels (exact): "Item name", "Slots", "Quantity", "Tier", "Max notches (optional)"; buttons "Add custom item", "Cancel". Errors render in a `role="alert"` paragraph.

- [ ] **Step 1: Add failing e2e tests**
  1. *adds a custom item*: click "+ Custom item"; fill Item name "Jade idol", Slots 2, Max notches 3; "Add custom item"; row "Jade idol" appears in Backpack showing "notches 0/3"; Backpack region name reflects 2 more used slots; reload; still present; move it to Worn and the Backpack count drops by 2.
  2. *rejects bad input*: blank name → alert "Give the item a name." and no new row; Slots 1.5 → alert containing "Slots"; form stays open with the typed values.
  3. *zero-slot trinket*: Slots 0 adds a row and leaves the Backpack meter text unchanged.

- [ ] **Step 2: Run** the spec — expect the new tests FAIL.
- [ ] **Step 3: Implement.** The form holds its own `$state` fields (defaults: slots 1, quantity 1, tier common, notches blank → `null`), calls `createCustomItem` in a try/catch on submit, shows `error.message`, and calls `onAdd` on success. Number inputs use `inputmode="numeric"` and are read with `Number(...)` so fractions reach the validator. In `GearPanel`, a "+ Custom item" button beside the market add row toggles the form; `onAdd` appends to `char.equipment`, closes the form and calls `onChange()`.
- [ ] **Step 4: Run** `npm run check` and the spec — expect PASS.
- [ ] **Step 5: Commit** `feat(sheet): add custom items to inventory`

---

## Part 2 — Rules side panel

### Task 5: Single-rule endpoint

**Files:**
- Create: `src/routes/api/rules/[id]/+server.ts`
- Test: `tests/unit/rules-api.test.ts` (new; follow how `tests/unit/denizens-api.test.ts` invokes a `+server.ts` handler)

**Interfaces:**
- Produces: `GET /api/rules/:id` → `200 { rule: RuleEntry }` with `Cache-Control: public, max-age=3600`; matches `rule.id` first, then any `rule.aliases` entry; `404` otherwise. No auth (rules pages are public).

- [ ] **Step 1: Failing tests:** known id (take `getRules()[0].id`) returns that rule and the cache header; an alias (find the first rule with `aliases?.length`) returns its owning rule; `no-such-rule` rejects with status 404.
- [ ] **Step 2: Run** `npx vitest run tests/unit/rules-api.test.ts` — FAIL.
- [ ] **Step 3: Implement** with `getRules()` from `$lib/server/content/loader`, `json()` and `error()` from `@sveltejs/kit`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(rules): endpoint for one rule's full text`

### Task 6: Headless panel state

**Files:**
- Create: `src/lib/components/rules/rules-side-panel.svelte.ts`
- Test: `tests/unit/components/rules-side-panel.test.ts` (model on `site-search.test.ts`, including its fake `KeyboardEvent`)

**Interfaces:**
- Consumes: `getRulesSearch`, `RuleSearchHit`, `RulesSearchEngine` from `$lib/search/rules-search`; `RuleEntry`.
- Produces:

```ts
export type RuleLoadStatus = 'idle' | 'loading' | 'ready' | 'error';
export function createRulesSidePanel(
	packVersion: string,
	deps?: { getEngine?: typeof getRulesSearch; fetchRule?: (id: string) => Promise<RuleEntry> }
): {
	readonly query: string;
	readonly status: SiteSearchStatus;          // search engine status
	readonly hits: RuleSearchHit[];             // max 15
	readonly active: number;                    // -1 when none
	readonly view: 'search' | 'rule';
	readonly rule: RuleEntry | null;
	readonly ruleStatus: RuleLoadStatus;
	readonly ruleId: string | null;             // id requested, kept on error for the fallback link
	readonly ruleSection: string | null;        // section for the fallback link when known
	readonly phrase: string | null;             // matched phrase of the opened hit
	onFocus(): void;
	onInput(value: string): void;               // also returns view to 'search'
	onKeydown(e: KeyboardEvent): void;          // ArrowUp/Down move active; Enter opens active; Escape in rule view → backToResults
	setComposing(v: boolean): void;
	openHit(index: number): Promise<void>;
	openRuleById(id: string): Promise<void>;    // for in-rule links; phrase = null
	backToResults(): void;                      // keeps query, hits and active
};
```

Default `fetchRule`: `fetch(`/api/rules/${encodeURIComponent(id)}?v=${packVersion}`)`, throw on non-OK, return `.rule`.

- [ ] **Step 1: Failing tests:** engine loads on first focus (`idle → loading → ready`); `onInput('challenge')` yields 2 hits with `active === 0`; ArrowDown/ArrowUp clamp; Enter calls `fetchRule` with the active hit's `doc.id`, then `view === 'rule'`, `ruleStatus === 'ready'`, `rule` set, `phrase` equals the hit's `phrase`; `backToResults()` restores `view === 'search'` with the same `query`, `hits`, `active`; Escape in rule view does the same; `fetchRule` rejecting gives `view === 'rule'`, `ruleStatus === 'error'`, `rule === null`, `ruleId` and `ruleSection` set; a slow first `openHit` resolving after a second `openHit` does not overwrite the second rule; `openRuleById('x')` sets `phrase` to `null`; `onInput` while in rule view switches to search view; Enter during composition does nothing; engine failure gives `status === 'error'` and a later `onFocus` retries.
- [ ] **Step 2: Run** `npx vitest run tests/unit/components/rules-side-panel.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Guard stale loads with a request counter.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(rules): side panel state module`

### Task 7: Panel UI, wide layout and `/` shortcut

**Files:**
- Create: `src/lib/components/rules/RulesSidePanel.svelte`, `src/lib/search/slash-target.svelte.ts`
- Modify: `src/lib/components/layout/SiteSearch.svelte` (`onWindowKeydown`), `src/routes/+layout.svelte`, `src/routes/sheet/[id]/+page.svelte`
- Test: `tests/e2e/sheet-rules-panel.spec.ts` (new); `tests/e2e/rules-search.spec.ts` must still pass

**Interfaces:**
- Consumes: `createRulesSidePanel` (Task 6); `RuleArticle`; `buildSnippet`, `sectionLabel`, `hitHref`; `highlightPhrase` / `clearPhraseHighlights` from `$lib/search/highlight-dom`; `MediaQuery` from `svelte/reactivity`.
- Produces: `RulesSidePanel` props `{ panel: ReturnType<typeof createRulesSidePanel> }`, root `<aside class="rules-panel" aria-label="Rules reference">`, input `aria-label="Search the rules beside the sheet"`. `slashTarget` — `export const slashTarget = $state<{ focus: (() => void) | null }>({ focus: null })`.

- [ ] **Step 1: Write failing e2e tests** (`signInAs`, `createTestAdventurer`, then `/sheet/:id`):
  1. *wide screen shows the panel and reads a rule in place* (viewport 1440×900): the "Rules reference" region is visible; type "wound" in its search; results list appears; click the first result; a rule heading and body render inside the region; URL is still `/sheet/:id`; the sheet's "Take a Wound…" button is still visible; "← Results" returns to the list with the query intact.
  2. *open in rules link*: the rule view's "Open in rules ↗" has `target="_blank"` and an `href` starting `/rules/`.
  3. *`/` focuses the panel on wide screens*, and on a 1024-wide viewport it focuses the header search instead.
  4. *no panel below 80rem* (1024×800): region count is 0; `scrollWidth <= innerWidth`; the `.sheet-page` width equals what it is on `main` (assert `<= 768`px).
  5. *state survives resize and saves*: open a rule at 1440; toggle a condition (triggers autosave) and wait for the PUT — rule still shown; resize to 1024 then back to 1440 — same rule shown, query intact.
  6. *load failure*: `page.route('**/api/rules/**', r => r.abort())`; click a result; an error message, "← Results" and a working "Open in rules ↗" link are shown.
  7. *in-rule link*: only if a rule containing a `/rules/…#id` link exists in the pack (search `static/content-packs/hmtw/rules.json` for `](/rules/`); click it and expect the panel to show the linked rule with the URL unchanged. If the pack has none, skip this test with a comment and cover the click handler by reviewing it.

- [ ] **Step 2: Run** `npx playwright test tests/e2e/sheet-rules-panel.spec.ts --trace off` — FAIL.

- [ ] **Step 3: Implement**
  - **Layout:** in `+layout.svelte`, add `class:wide={page.route.id === '/sheet/[id]'}` on `.site` and `@media (min-width: 80rem) { .site.wide { max-width: 104rem; } }`.
  - **Sheet page:** create the panel state once at page level (`createRulesSidePanel(data.packVersion)` — `packVersion` comes from the root layout data) so it survives the panel unmounting. `const wide = new MediaQuery('min-width: 80rem')`. Wrap existing content in `.sheet-col` (keeps `max-width: 48rem`); when `wide.current`, render `<RulesSidePanel {panel} />` beside it in a two-column grid (`minmax(0, 48rem) minmax(22rem, 28rem)`, gap `2rem`, centred). `.sheet-page`'s own `max-width: 48rem` applies only below 80rem.
  - **Panel:** `position: sticky; top: 1rem; max-height: calc(100vh - 2rem); overflow-y: auto`. Search view: input, `role="status"` result count, states with the header search's wording ("loading the rulebook…", "search unavailable — browse the rules index", "No rules match “…”."), empty-query hint "Search the rules without leaving your sheet.", results as a listbox with the same title / section crumb / snippet markup as `SiteSearch`. Rule view: "← Results" button, "Open in rules ↗" link (`hitHref` when opened from a hit, else `/rules/${section}#${id}`), then `<RuleArticle {rule} />`; loading and error states. After the rule renders, `clearPhraseHighlights(panelEl)` then, if `panel.phrase`, `highlightPhrase(articleEl, phrase)?.scrollIntoView({ block: 'center' })`; otherwise scroll the panel to top. Copy the `mark.phrase-hl` style from the section page.
  - **In-rule links:** one delegated `click` handler on the rule container: for an `<a>` whose URL is same-origin, path matches `/rules/<section>` and has a hash, `preventDefault()` and `panel.openRuleById(hash.slice(1))`. Modifier-clicks and all other links are left alone.
  - **`/` shortcut:** the panel sets `slashTarget.focus` to focus its input on mount and resets it to `null` on destroy. In `SiteSearch.onWindowKeydown`, after the existing guards and `preventDefault()`, call `slashTarget.focus ? slashTarget.focus() : input?.focus()`.

- [ ] **Step 4: Run** `npm run check`, `npm run test`, `npx playwright test tests/e2e/sheet-rules-panel.spec.ts tests/e2e/rules-search.spec.ts tests/e2e/sheet-gear.spec.ts tests/e2e/campaign-mobile.spec.ts --trace off` — expect PASS.

- [ ] **Step 5: Commit** `feat(sheet): rules reference panel beside the sheet on wide screens`

### Task 8: Changelog and full verification

**Files:**
- Modify: `CHANGELOG.md` (Unreleased, Keep a Changelog)

- [ ] **Step 1:** Add under **Added**: gear panel on the play view with autosave, location groups and open-slot boxes; custom inventory items with optional durability; rules reference panel beside the sheet on wide screens. Under **Changed**: gear is no longer edited in Edit mode.
- [ ] **Step 2: Run** `npm run check && npm run test && npm run test:e2e -- --trace off` — expect all PASS. Fix anything this branch broke; report anything that was already failing on `main`.
- [ ] **Step 3:** Start the dev server and look at `/sheet/:id` at 1440px and 390px in light and dark themes: slot boxes legible, no overflow, panel sticky. Screenshot both for the PR.
- [ ] **Step 4: Commit** `docs(changelog): gear panel, custom items, rules side panel`
