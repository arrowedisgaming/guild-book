# Multiple Items in Inventory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an adventurer take more than one of the same item at the Omphalic Market and post-creation, with the market allowance counted per copy and carrying capacity shown but not enforced.

**Architecture:** The cart in the creation wizard changes from `Set<string>` to `Map<string, number>` (item id → quantity), emitting one `EquipmentEntry` per item carrying the aggregate quantity. The pure cart logic lives in a new engine module, `src/lib/engine/market-cart.ts`, so it is unit testable without a DOM. One engine gap is closed: `autoPlace` must split a multi-quantity armor entry so only one suit is worn.

**Tech Stack:** SvelteKit 2 / Svelte 5 runes, TypeScript strict, Vitest (unit), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-08-02-inventory-multiples-design.md`
**Issue:** https://github.com/arrowedisgaming/hmtw-guildbook/issues/29

## Global Constraints

- Engine modules (`src/lib/engine/*`) must be pure: no side effects, no imports from `$app/` or `$lib/server/`. Type-only imports are fine.
- Game data stays in `static/content-packs/hmtw/`. This plan changes **no** content-pack JSON.
- Market allowance is read from the content pack (`creation.marketAllowance`), currently `luxurious: 1, common: 5, impoverished: null`. Never hardcode these numbers.
- Allowance counts **per copy**: two daggers spend two of the five common picks.
- A stackable pick grants a **full stack** (`stack.per` units): taking Arrows grants 12.
- Carrying capacity **warns, does not block**. Only the tier cap disables the `+` control. This preserves the documented stance in `src/lib/engine/encumbrance.ts`: "Capacity overruns don't block placement (guide, don't enforce)".
- The item card in the wizard must keep `role="checkbox"` and its `aria-checked` state. `tests/e2e/wizard-smoke.test.ts:39` drives this step with `page.getByRole('checkbox').first().click()`.
- Svelte 5 runes only: `$props()` with destructuring, `$state()`, `$derived()`, `$derived.by()`.
- Never add automated-authorship attribution or generated-by footers to commits.
- `main` is pull-request-only. Work on a branch; do not push to `main`.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/engine/market-cart.ts` *(create)* | Pure market-cart logic: build a cart from entries, step a quantity, count tier picks, emit equipment entries, report a pick's step size. |
| `tests/unit/market-cart.test.ts` *(create)* | Unit tests for the above. |
| `src/lib/engine/encumbrance.ts` *(modify)* | `autoPlace` splits a multi-quantity armor entry into one worn suit plus packed spares. |
| `tests/unit/encumbrance.test.ts` *(modify)* | Tests for the armor split. |
| `src/routes/create/hmtw/equipment/+page.svelte` *(modify)* | Wizard UI: `Map` cart, per-card quantity stepper, per-copy tier counting. |
| `src/lib/components/character/edit/GearEdit.svelte` *(modify)* | Post-creation stepper available on every item, stepping by stack size. |
| `src/routes/create/hmtw/review/+page.svelte` *(modify)* | Render `×N` in the Gear list. |
| `tests/e2e/wizard-smoke.test.ts` *(modify)* | End-to-end: take two of an item, assert `×2` survives to review and to the saved sheet. |

## Background for the implementer

Read these before starting. Do not re-derive them.

- `EquipmentEntry` (`src/lib/types/character.ts:62-75`) **already has** `quantity`. So does the Zod schema (`src/lib/schemas/character.schema.ts:38-46`) and `migrateCharacterData` (`src/lib/engine/character-migration.ts:69`). **No type, schema, migration or database change is needed.**
- `slotsFor` (`src/lib/engine/encumbrance.ts:19-30`) already does stack-aware slot math: quantity 12 of Arrows is 1 slot, 13 is 2 slots. Do not touch it.
- The character sheet, PDF export and markdown export already render `×N`. Do not touch them.
- `ItemDefinition` (`src/lib/types/content-pack.ts:144-157`) fields that matter here: `slots?: number` (default 1), `carry?: 'any' | 'belt-only' | 'hand'`, `wornBeltSlots?: number` (armor only), `stack?: { per: number; unit?: string }`.
- Stackable items in the pack: `iron-spikes` (6, "spikes"), `arrows` (12, "arrows"), `bolts` (12, "bolts"), `chain` (1, "10 ft"), `lockpicks` (6, "picks").
- Armor with `wornBeltSlots`: `armor-light` (1 belt slot, common), `armor-iron` (2, luxurious), `armor-steel` (3, luxurious).

Run unit tests with `npm test`. Run a single file with `npm test -- tests/unit/market-cart.test.ts`. Run e2e with `npm run test:e2e`.

---

### Task 1: Market cart engine module

**Files:**
- Create: `src/lib/engine/market-cart.ts`
- Test: `tests/unit/market-cart.test.ts`

**Interfaces:**
- Consumes: `EquipmentEntry` from `$lib/types/character`; `ItemDefinition` from `$lib/types/content-pack`; `ItemTier` from `$lib/types/common`.
- Produces, relied on by Tasks 3 and 4:
  - `type MarketCart = ReadonlyMap<string, number>`
  - `stepSize(def: ItemDefinition | undefined): number`
  - `cartFromEntries(entries: readonly EquipmentEntry[]): Map<string, number>`
  - `stepCart(cart: MarketCart, itemId: string, def: ItemDefinition | undefined, delta: 1 | -1): Map<string, number>`
  - `tierPicks(cart: MarketCart, items: readonly ItemDefinition[], tier: ItemTier, exempt: ReadonlySet<string>): number`
  - `cartToEntries(cart: MarketCart, items: readonly ItemDefinition[]): EquipmentEntry[]`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/market-cart.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
	stepSize,
	cartFromEntries,
	stepCart,
	tierPicks,
	cartToEntries
} from '$lib/engine/market-cart';
import { getItems } from '$lib/server/content/loader';
import type { EquipmentEntry } from '$lib/types/character';

const items = getItems();
const def = (id: string) => items.find((i) => i.id === id);
const NONE = new Set<string>();

function entry(itemId: string, overrides: Partial<EquipmentEntry> = {}): EquipmentEntry {
	const d = def(itemId)!;
	return {
		itemId,
		customName: null,
		tier: d.tier,
		packSpace: d.slots ?? 1,
		location: 'pack',
		quantity: 1,
		notchesTaken: 0,
		...overrides
	};
}

describe('stepSize', () => {
	it('is one for a plain item', () => {
		expect(stepSize(def('rope'))).toBe(1);
		expect(stepSize(undefined)).toBe(1);
	});

	it('is a full stack for a stackable', () => {
		expect(stepSize(def('arrows'))).toBe(12);
		expect(stepSize(def('lockpicks'))).toBe(6);
		expect(stepSize(def('chain'))).toBe(1);
	});
});

describe('cartFromEntries', () => {
	it('reads quantities back off persisted entries', () => {
		const cart = cartFromEntries([entry('rope', { quantity: 2 }), entry('arrows', { quantity: 24 })]);
		expect(cart.get('rope')).toBe(2);
		expect(cart.get('arrows')).toBe(24);
	});

	it('sums entries that autoPlace split across locations', () => {
		const cart = cartFromEntries([
			entry('armor-light', { location: 'worn', quantity: 1 }),
			entry('armor-light', { location: 'pack', quantity: 1 })
		]);
		expect(cart.get('armor-light')).toBe(2);
	});

	it('ignores custom entries that have no item id', () => {
		const cart = cartFromEntries([entry('rope'), { ...entry('rope'), itemId: null }]);
		expect(cart.size).toBe(1);
	});
});

describe('stepCart', () => {
	it('takes one unit of a plain item', () => {
		expect(stepCart(new Map(), 'rope', def('rope'), 1).get('rope')).toBe(1);
	});

	it('takes a whole stack of a stackable', () => {
		expect(stepCart(new Map(), 'arrows', def('arrows'), 1).get('arrows')).toBe(12);
	});

	it('adds another stack on a second pick', () => {
		const one = stepCart(new Map(), 'arrows', def('arrows'), 1);
		expect(stepCart(one, 'arrows', def('arrows'), 1).get('arrows')).toBe(24);
	});

	it('removes the item when stepping below one step', () => {
		const one = stepCart(new Map(), 'rope', def('rope'), 1);
		expect(stepCart(one, 'rope', def('rope'), -1).has('rope')).toBe(false);

		const quiver = stepCart(new Map(), 'arrows', def('arrows'), 1);
		expect(stepCart(quiver, 'arrows', def('arrows'), -1).has('arrows')).toBe(false);
	});

	it('does not mutate the cart it was given', () => {
		const before = new Map([['rope', 1]]);
		stepCart(before, 'rope', def('rope'), 1);
		expect(before.get('rope')).toBe(1);
	});
});

describe('tierPicks', () => {
	it('counts every copy against the allowance', () => {
		const cart = new Map([['weapon-silver', 2]]);
		expect(tierPicks(cart, items, 'luxurious', NONE)).toBe(2);
	});

	it('counts a stackable by stacks, not by units', () => {
		const cart = new Map([['lockpicks', 12]]);
		expect(tierPicks(cart, items, 'common', NONE)).toBe(2);
	});

	it('only counts the tier asked for', () => {
		const cart = new Map([
			['weapon-silver', 1],
			['lockpicks', 6]
		]);
		expect(tierPicks(cart, items, 'luxurious', NONE)).toBe(1);
		expect(tierPicks(cart, items, 'common', NONE)).toBe(1);
	});

	it('exempts talent-required items entirely', () => {
		const cart = new Map([['lockpicks', 18]]);
		expect(tierPicks(cart, items, 'common', new Set(['lockpicks']))).toBe(0);
	});
});

describe('cartToEntries', () => {
	it('emits one entry per item carrying the aggregate quantity', () => {
		const entries = cartToEntries(new Map([['rope', 3]]), items);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			itemId: 'rope',
			customName: null,
			tier: 'impoverished',
			packSpace: 1,
			location: 'pack',
			quantity: 3,
			notchesTaken: 0
		});
	});

	it('follows content-pack order, not insertion order', () => {
		const late = items[items.length - 1].id;
		const early = items[0].id;
		const entries = cartToEntries(
			new Map([
				[late, 1],
				[early, 1]
			]),
			items
		);
		expect(entries.map((e) => e.itemId)).toEqual([early, late]);
	});

	it('skips ids that are not in the pack', () => {
		expect(cartToEntries(new Map([['not-a-real-item', 1]]), items)).toEqual([]);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/unit/market-cart.test.ts`
Expected: FAIL — the module `$lib/engine/market-cart` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/lib/engine/market-cart.ts`:

```ts
/**
 * The Omphalic Market cart: item id → quantity held. Pure.
 *
 * A market "pick" is one unit of a plain item, or one full stack of a
 * stackable — Ch1 "Treats from Ma" grants 1 luxurious and 5 common ITEMS, and
 * arrows "come in quivers of 12 per slot", so a quiver is one pick, not twelve.
 * The allowance is therefore counted per copy: two daggers spend two picks.
 */

import type { EquipmentEntry } from '$lib/types/character';
import type { ItemDefinition } from '$lib/types/content-pack';
import type { ItemTier } from '$lib/types/common';

/** Item id → units held. An absent key means the item is not taken. */
export type MarketCart = ReadonlyMap<string, number>;

/** Units one pick grants: a full stack for stackables, otherwise one. */
export function stepSize(def: ItemDefinition | undefined): number {
	const per = def?.stack?.per;
	return per && per > 0 ? per : 1;
}

/** Rebuild a cart from persisted entries, summing duplicate item ids —
 * `autoPlace` may have split one item across two locations. */
export function cartFromEntries(entries: readonly EquipmentEntry[]): Map<string, number> {
	const cart = new Map<string, number>();
	for (const entry of entries) {
		if (!entry.itemId) continue; // free-typed custom gear has no market id
		cart.set(entry.itemId, (cart.get(entry.itemId) ?? 0) + Math.max(1, entry.quantity));
	}
	return cart;
}

/** Add or drop one pick's worth. Dropping below a single step removes the
 * item outright, so `−` on the last unit un-takes it. Never mutates `cart`. */
export function stepCart(
	cart: MarketCart,
	itemId: string,
	def: ItemDefinition | undefined,
	delta: 1 | -1
): Map<string, number> {
	const next = new Map(cart);
	const step = stepSize(def);
	const quantity = (next.get(itemId) ?? 0) + delta * step;
	if (quantity < step) next.delete(itemId);
	else next.set(itemId, quantity);
	return next;
}

/** Market picks spent in one tier. Stackables count by stack, and items your
 * talents require are exempt — Ch1: "You can have as many as you want." */
export function tierPicks(
	cart: MarketCart,
	items: readonly ItemDefinition[],
	tier: ItemTier,
	exempt: ReadonlySet<string>
): number {
	let picks = 0;
	for (const def of items) {
		if (def.tier !== tier || exempt.has(def.id)) continue;
		const quantity = cart.get(def.id);
		if (!quantity) continue;
		picks += Math.ceil(quantity / stepSize(def));
	}
	return picks;
}

/** One entry per taken item carrying the aggregate quantity — `slotsFor`
 * already does the stack math, so splitting into per-copy entries would only
 * lose information. Placement is left to `autoPlace`. Content-pack order. */
export function cartToEntries(
	cart: MarketCart,
	items: readonly ItemDefinition[]
): EquipmentEntry[] {
	return items
		.filter((def) => (cart.get(def.id) ?? 0) > 0)
		.map((def) => ({
			itemId: def.id,
			customName: null,
			tier: def.tier,
			packSpace: def.slots ?? 1,
			location: 'pack' as const,
			quantity: cart.get(def.id)!,
			notchesTaken: 0
		}));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/unit/market-cart.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Type check**

Run: `npm run check`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/engine/market-cart.ts tests/unit/market-cart.test.ts
git commit -m "feat(engine): market cart with per-copy picks and stack-sized steps"
```

---

### Task 2: Wear one suit of armor, pack the spares

Two suits of light armor are reachable now that copies are allowed (two of five common picks). `autoPlace` currently maps entries 1:1 and marks the whole entry `worn`, and `slotsFor` bills a worn entry `def.wornBeltSlots` regardless of quantity — so the second suit would ride free. Split it instead.

**Files:**
- Modify: `src/lib/engine/encumbrance.ts:96-135`
- Test: `tests/unit/encumbrance.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `autoPlace` keeps its signature `(entries, items, caps) => EquipmentEntry[]` but may now return **more** entries than it was given. Task 3 relies on this being safe to feed straight into `loadSummary` and to persist.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/encumbrance.test.ts`, inside the existing `describe('autoPlace', ...)` block if there is one, otherwise as a new `describe` at the end of the file:

```ts
describe('autoPlace with multiple suits of armor', () => {
	it('wears one suit and packs the spare', () => {
		const placed = autoPlace([entry('armor-light', { quantity: 2 })], items, caps);
		expect(placed).toHaveLength(2);
		expect(placed[0]).toMatchObject({ itemId: 'armor-light', location: 'worn', quantity: 1 });
		expect(placed[1]).toMatchObject({ itemId: 'armor-light', location: 'pack', quantity: 1 });
	});

	it('bills only the worn suit against the belt', () => {
		const placed = autoPlace([entry('armor-light', { quantity: 2 })], items, caps);
		const load = loadSummary(placed, items, caps);
		expect(load.belt.used).toBe(1); // one suit's wornBeltSlots, not two
		expect(load.pack.used).toBe(1); // the spare, at its 1 base slot
	});

	it('leaves a single suit as one worn entry', () => {
		const placed = autoPlace([entry('armor-light')], items, caps);
		expect(placed).toHaveLength(1);
		expect(placed[0]).toMatchObject({ location: 'worn', quantity: 1 });
	});

	it('still packs non-armor multiples as one entry', () => {
		const placed = autoPlace([entry('rations', { quantity: 3 })], items, caps);
		expect(placed).toHaveLength(1);
		expect(placed[0]).toMatchObject({ location: 'pack', quantity: 3 });
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/unit/encumbrance.test.ts`
Expected: FAIL — "wears one suit and packs the spare" gets length 1, not 2.

- [ ] **Step 3: Change `autoPlace` from `map` to `flatMap`**

In `src/lib/engine/encumbrance.ts`, update the doc comment's rule 1 and rewrite the body. Replace the whole `return entries.map(...)` block with:

```ts
	return entries.flatMap((entry): EquipmentEntry[] => {
		const def = entry.itemId ? items.get(entry.itemId) : undefined;
		const place = (location: CarryLocation): EquipmentEntry[] => [{ ...entry, location }];

		if (def?.wornBeltSlots && !wornArmor) {
			wornArmor = true; // wear the first suit of armor; spares travel in the pack
			beltUsed += def.wornBeltSlots;
			if (entry.quantity > 1) {
				// You can only wear one suit. Split so the belt is billed once and
				// the spares are honestly carried rather than silently free.
				return [
					{ ...entry, location: 'worn', quantity: 1 },
					{ ...entry, location: 'pack', quantity: entry.quantity - 1 }
				];
			}
			return place('worn');
		}
		if (def && (def.category === 'clothing' || (def.category === 'armor' && !def.wornBeltSlots))) {
			return place('worn'); // clothes and helms: worn free
		}
		if (def?.carry === 'belt-only') {
			beltUsed += slotsFor({ ...entry, location: 'belt' }, def);
			return place('belt');
		}
		if (def?.carry === 'hand') {
			const slots = slotsFor({ ...entry, location: 'hand' }, def);
			if (handUsed + slots <= caps.handSlots) {
				handUsed += slots;
				return place('hand');
			}
			if (beltUsed + slots <= caps.beltSlots) {
				beltUsed += slots;
				return place('belt');
			}
			return place('pack');
		}
		return place('pack');
	});
```

Also update rule 1 in the function's doc comment above it, from:

```
 *  1. Armor (has wornBeltSlots) is worn — billed against the belt.
```

to:

```
 *  1. Armor (has wornBeltSlots) is worn — billed against the belt. Only ONE
 *     suit can be worn, so a multi-quantity armor entry is split: one worn,
 *     the spares packed.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/unit/encumbrance.test.ts`
Expected: PASS, including every pre-existing case in the file.

- [ ] **Step 5: Run the full unit suite**

Run: `npm test`
Expected: PASS. `autoPlace` is also called by `GearEdit`'s Auto-arrange; nothing else should regress.

- [ ] **Step 6: Commit**

```bash
git add src/lib/engine/encumbrance.ts tests/unit/encumbrance.test.ts
git commit -m "fix(engine): wear one suit of armor and pack the spares"
```

---

### Task 3: Quantity stepper in the market wizard

**Files:**
- Modify: `src/routes/create/hmtw/equipment/+page.svelte`

**Interfaces:**
- Consumes from Task 1: `stepSize`, `cartFromEntries`, `stepCart`, `tierPicks`, `cartToEntries`, `type MarketCart`.
- Consumes from Task 2: `autoPlace` may return more entries than given.
- Produces: nothing later tasks import.

- [ ] **Step 1: Replace the cart state and its derivations**

In the `<script>` block, replace the imports on line 6 and the state on lines 36-70.

Change the engine import to:

```ts
	import { autoPlace, loadSummary, indexItems } from '$lib/engine/encumbrance';
	import {
		cartFromEntries,
		cartToEntries,
		stepCart,
		stepSize,
		tierPicks,
		type MarketCart
	} from '$lib/engine/market-cart';
```

Replace `let selected = $state<Set<string>>(...)` with:

```ts
	let cart = $state<MarketCart>(cartFromEntries($wizard.character.equipment));
```

Delete the `toEntries` function entirely and replace the `placed` derivation:

```ts
	// Live auto-placement + slot meters, recomputed as the cart changes.
	const placed = $derived(autoPlace(cartToEntries(cart, data.items), itemIndex, caps));
	const load = $derived(loadSummary(placed, itemIndex, caps));
```

Replace `countInTier` and `atCap` with:

```ts
	function countInTier(tier: ItemTier): number {
		return tierPicks(cart, data.items, tier, requiredItemIds);
	}
	/** True when one more pick of this item would break the tier allowance. */
	function atCap(tier: ItemTier, itemId: string): boolean {
		const cap = tierCaps[tier];
		if (cap === null || requiredItemIds.has(itemId)) return false;
		return countInTier(tier) >= cap;
	}
```

Replace `toggle` and `chooseItem` with:

```ts
	function step(itemId: string, delta: 1 | -1) {
		detailItemId = itemId;
		cart = stepCart(cart, itemId, itemIndex.get(itemId), delta);
	}
	/** Clicking the card body takes one; at the tier cap it only shows details. */
	function chooseItem(itemId: string, unavailable = false) {
		detailItemId = itemId;
		if (unavailable) return;
		if (cart.has(itemId)) step(itemId, -1);
		else step(itemId, 1);
	}
	/** "×24 arrows" for stackables, "×2" for everything else. */
	function quantityLabel(itemId: string): string {
		const quantity = cart.get(itemId) ?? 0;
		const unit = itemIndex.get(itemId)?.stack?.unit;
		return unit ? `×${quantity} ${unit}` : `×${quantity}`;
	}
```

Note: `chooseItem` on a taken item now steps **down** by one rather than clearing the whole stack. That keeps a single click reversible, which is what the smoke test's click-once behaviour relies on.

- [ ] **Step 2: Restructure the item card markup**

A `<button>` cannot contain other buttons, so the card becomes a `<div>` wrapper holding the existing `role="checkbox"` button plus a stepper. Replace the tier-loop card (lines 166-181) with:

```svelte
			{#each itemsByTier(tier) as item (item.id)}
				{@const taken = cart.has(item.id)}
				{@const full = atCap(tier, item.id)}
				<div class="item" class:sel={taken} class:focused={detailItemId === item.id} class:disabled={full && !taken}>
					<button
						type="button"
						class="pick"
						role="checkbox"
						aria-checked={taken}
						aria-label={`${item.name}${full && !taken ? ', unavailable because the tier limit is reached; show details' : ''}`}
						onclick={() => chooseItem(item.id, full && !taken)}
					>
						<span class="check" aria-hidden="true">{taken ? '☑' : '☐'}</span>
						<span class="iname">{item.name}</span>
						<span class="islots">{item.slots ?? 1} slot{(item.slots ?? 1) === 1 ? '' : 's'}{item.carry === 'belt-only' ? ' · belt only' : ''}{item.stack ? ` · ${item.stack.per}/slot` : ''}</span>
					</button>
					{#if taken}
						<div class="qty">
							<button type="button" onclick={() => step(item.id, -1)} aria-label={`Remove one ${item.name}`}>−</button>
							<span class="qnum" aria-live="polite">{quantityLabel(item.id)}</span>
							<button type="button" disabled={full} onclick={() => step(item.id, 1)} aria-label={`Add another ${item.name}`}>+</button>
						</div>
					{/if}
				</div>
			{/each}
```

Apply the same treatment to the talent-required card (lines 132-144), which has no cap:

```svelte
			{#each requiredItems as item (item.id)}
				{@const taken = cart.has(item.id)}
				<div class="item req" class:sel={taken} class:focused={detailItemId === item.id}>
					<button
						type="button"
						class="pick"
						role="checkbox"
						aria-checked={taken}
						onclick={() => chooseItem(item.id)}
					>
						<span class="check" aria-hidden="true">{taken ? '☑' : '☐'}</span>
						<span class="iname">{item.name}</span>
					</button>
					{#if taken}
						<div class="qty">
							<button type="button" onclick={() => step(item.id, -1)} aria-label={`Remove one ${item.name}`}>−</button>
							<span class="qnum" aria-live="polite">{quantityLabel(item.id)}</span>
							<button type="button" onclick={() => step(item.id, 1)} aria-label={`Add another ${item.name}`}>+</button>
						</div>
					{/if}
				</div>
			{/each}
```

Also update the two remaining `selected.has(...)` references if any survive — search the file for `selected` and confirm zero matches before moving on.

- [ ] **Step 3: Move the card styles onto the inner button and add the stepper**

The old `.item` rule owned the grid. Split it: `.item` becomes the wrapper, `.pick` gets the grid. In the `<style>` block, replace the `.item` rule (lines 271-285) and the `.check` / `.iname` / `.islots` grid-area rules keep working because they now sit inside `.pick`.

```css
	.item {
		display: flex;
		flex-direction: column;
		border: 1px solid color-mix(in oklab, var(--ink) 18%, transparent);
		border-radius: 4px;
		background: var(--parchment);
	}
	.pick {
		display: grid;
		grid-template-columns: auto 1fr;
		grid-template-areas: 'chk name' 'chk slots';
		gap: 0.1rem 0.5rem;
		align-items: start;
		padding: 0.55rem 0.7rem;
		border: none;
		border-radius: 4px;
		cursor: pointer;
		text-align: left;
		background: transparent;
		color: inherit;
		font: inherit;
	}
	.qty {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0 0.7rem 0.5rem;
		font-family: var(--font-subhead);
		font-size: 0.8rem;
		color: var(--ink-soft);
	}
	.qty button {
		width: 1.5rem;
		height: 1.5rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 3px;
		background: var(--parchment);
		color: inherit;
		font: inherit;
		cursor: pointer;
	}
	.qty button:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.qnum {
		min-width: 3.5rem;
		text-align: center;
	}
```

Then change `.item.disabled { cursor: not-allowed; }` to target the button instead, since the wrapper is no longer clickable:

```css
	.item.disabled {
		opacity: 0.45;
	}
	.item.disabled .pick {
		cursor: not-allowed;
	}
```

- [ ] **Step 4: Type check and run the unit suite**

Run: `npm run check && npm test`
Expected: no new type errors, all unit tests pass.

- [ ] **Step 5: Verify in the browser**

Start the dev server and walk to `/create/hmtw/equipment`. Confirm by observation:
- Clicking an untaken card takes one and reveals the stepper.
- `+` on Rope goes to `×2`; the Backpack meter climbs by 1 each time.
- `+` on Arrows shows `×24 arrows` and the Backpack meter climbs by only 1, because 24 arrows are 2 slots.
- Taking two common items disables `+` on every common item once the counter reads `5 / 5`.
- Filling the pack past 21 reddens the meter and shows the warning, but `+` still works.
- Continue, then use the wizard's Back button — the quantities are still there.

- [ ] **Step 6: Commit**

```bash
git add src/routes/create/hmtw/equipment/+page.svelte
git commit -m "feat(wizard): take multiples of an item at the market"
```

---

### Task 4: Multiples post-creation, and ×N on review

**Files:**
- Modify: `src/lib/components/character/edit/GearEdit.svelte:40-44,104-110`
- Modify: `src/routes/create/hmtw/review/+page.svelte:101`

**Interfaces:**
- Consumes from Task 1: `stepSize`.
- Produces: nothing.

- [ ] **Step 1: Let every item be multiplied in `GearEdit`**

The stepper is currently gated on `defFor(e.itemId)?.stack`, so a second dagger is unreachable after creation too. Remove the gate and step by stack size so it agrees with the market.

Add the import beside the existing engine import:

```ts
	import { stepSize } from '$lib/engine/market-cart';
```

Replace `stepQty` (lines 40-44):

```ts
	function stepQty(i: number, delta: number) {
		const e = char.equipment[i];
		const step = stepSize(defFor(e.itemId));
		char.equipment[i] = { ...e, quantity: Math.max(step, e.quantity + delta * step) };
		onChange();
	}
```

Replace the gated control block (lines 104-110) with an ungated one:

```svelte
			<span class="ctrl">
				qty {e.quantity}
				<button type="button" onclick={() => stepQty(i, -1)} aria-label="Remove one">−</button>
				<button type="button" onclick={() => stepQty(i, 1)} aria-label="Add one">+</button>
			</span>
```

- [ ] **Step 2: Show ×N on the review step**

In `src/routes/create/hmtw/review/+page.svelte`, replace line 101:

```svelte
		<ul class="inline">{#each char.equipment as e}<li>{itemName(e.itemId)}{e.quantity > 1 ? ` ×${e.quantity}` : ''}</li>{/each}</ul>
```

- [ ] **Step 3: Type check and run the unit suite**

Run: `npm run check && npm test`
Expected: no new type errors, all unit tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/components/character/edit/GearEdit.svelte src/routes/create/hmtw/review/+page.svelte
git commit -m "feat(sheet): step any item's quantity and show multiples on review"
```

---

### Task 5: End-to-end coverage

**Files:**
- Modify: `tests/e2e/wizard-smoke.test.ts:37-52`

**Interfaces:**
- Consumes: the wizard behaviour built in Tasks 3 and 4.
- Produces: nothing.

- [ ] **Step 1: Extend the smoke test to take two of an item**

The market section of the existing test currently reads:

```ts
	await expect(page.getByRole('heading', { name: 'The Omphalic Market' })).toBeVisible();
	await page.getByRole('checkbox').first().click();
	await page.getByRole('button', { name: 'Continue' }).click();
```

Replace it with:

```ts
	await expect(page.getByRole('heading', { name: 'The Omphalic Market' })).toBeVisible();
	await page.getByRole('checkbox').first().click();
	// Rope is impoverished, so it is never capped — take a second length.
	await page.getByRole('checkbox', { name: 'Rope', exact: true }).click();
	await page.getByRole('button', { name: 'Add another Rope' }).click();
	await expect(page.getByText('×2', { exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Continue' }).click();
```

Then, in the review assertions that follow, add before the `Save adventurer` check:

```ts
	await expect(page.getByRole('listitem').filter({ hasText: 'Rope ×2' })).toBeVisible();
```

And after the save, once the test lands on `/characters`, the sheet already renders `×N` — no extra assertion is needed there beyond the existing name check.

- [ ] **Step 2: Run the smoke test**

Run: `npm run test:e2e -- tests/e2e/wizard-smoke.test.ts`
Expected: PASS. If the first `getByRole('checkbox').first()` click happens to land on Rope, the subsequent named click would step it back down to zero — if that happens, change the first click to a different named item, e.g. `page.getByRole('checkbox', { name: 'Bedroll', exact: true }).click()`.

- [ ] **Step 3: Run the whole e2e suite**

Run: `npm run test:e2e`
Expected: PASS. Watch particularly for other specs that reach the market step.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/wizard-smoke.test.ts
git commit -m "test(e2e): cover taking multiples at the market"
```

---

### Task 6: Changelog and pull request

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add the changelog entry**

`CHANGELOG.md:9` has an empty `## [Unreleased]` section. Fill it in. The file's
house style is user-facing prose with no issue numbers or link references — do
not add either.

```markdown
## [Unreleased]

### Added

- Adventurers can now take more than one of the same item, both at the Omphalic
  Market during creation and on the character sheet afterwards. Each copy spends
  one of your market picks, so two daggers cost two of your five common items.
  Stackable gear is taken a stack at a time — choosing arrows gets you a quiver
  of twelve, which is what the rules give you and what a slot holds. Going over
  your belt or backpack still only warns you; it never stops you choosing.

### Fixed

- A second suit of armor no longer travels for free. Only one suit is worn and
  billed against the belt; the spares are carried in the backpack, where they
  take up the room they should.
```

- [ ] **Step 2: Run the full verification**

Run: `npm run check && npm test && npm run test:e2e`
Expected: all pass.

- [ ] **Step 3: Commit and open the pull request**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for multiple items in inventory"
git push -u origin HEAD
gh pr create --title "Take multiples of an item in inventory" --body "Closes #29"
```

If the push is refused by the local gate, hand the user the command to run themselves rather than retrying.

---

## Self-review notes

**Spec coverage:** cart representation → Task 1 + Task 3 Step 1; item card UI → Task 3 Steps 2-3; allowance counting → Task 1 (`tierPicks`) + Task 3 Step 1 (`atCap`); armor split → Task 2; `GearEdit` gate and review `×N` → Task 4; testing section → Tasks 1, 2 and 5. Out-of-scope items (partial-fit placement, allowance values, per-copy notches) have no task, as intended.

**Deviation from the spec, deliberate:** the spec sketched the stackable label as `×24 (2 quivers)`. The pack's `stack.unit` values are `"arrows"`, `"picks"`, `"spikes"`, `"10 ft"` — units of the countable thing, not stack names, so there is no "quiver" string to render. The plan uses `×24 arrows`, which is content-driven and reads correctly for every stackable in the pack. Amend the spec line to match.

**Type consistency:** `stepSize`, `cartFromEntries`, `stepCart`, `tierPicks`, `cartToEntries` and `MarketCart` are named identically in Task 1's implementation, Task 3's imports and Task 4's import. `autoPlace` keeps its signature; only its cardinality changes, which Task 2's Interfaces block states and Task 3 relies on.
