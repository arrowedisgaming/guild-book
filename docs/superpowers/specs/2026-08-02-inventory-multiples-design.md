# Multiple items in inventory — design

Issue: [#29 Multiple items in inventory](https://github.com/arrowedisgaming/hmtw-guildbook/issues/29)
Date: 2026-08-02

## Problem

An adventurer cannot take two of the same item. The creation wizard models the
market cart as `Set<string>` of item ids ([equipment/+page.svelte:36][cart]), so
one-of-each is structurally impossible to exceed, and every entry it emits
hardcodes `quantity: 1`. The post-creation editor is only slightly better: its
quantity stepper is gated on `defFor(e.itemId)?.stack` ([GearEdit.svelte:104][gate]),
so a second dagger is unreachable there too.

Everything downstream of the wizard already handles multiples. `EquipmentEntry`
carries `quantity`; `slotsFor` does stack-aware slot math (arrows 12/slot,
lockpicks 6/slot); `migrateCharacterData` defaults a missing quantity to 1; and
the character sheet, PDF export and markdown export all render `×N`. The fix is
therefore almost entirely a wizard-UI change, plus one engine gap that only
becomes reachable once multiples exist.

## Rules basis

`rules.json`, "Treats from Ma":

> Choose 1 luxurious item, 5 common items, and as many impoverished items as you
> want. Keep choosing items until your belt and your backpack are full.
>
> If any of your talents require specific items […] these items count as
> impoverished items for you during the Call to Adventure. You can have as many
> as you want.

`items.json`, Arrows: "They come in quivers of 12 per slot."

## Decisions

1. **Allowance counts per copy.** Two daggers spend two of the five common
   picks. This is the plain reading of "choose 5 common items"; counting per
   distinct item would let a single pick become unlimited copies.
2. **A stackable pick grants a full stack.** Taking Arrows grants 12 arrows
   (one slot, one quiver), and the stepper moves a whole stack at a time. This
   also corrects an existing defect: the wizard currently grants a single arrow.
3. **Capacity warns, it does not block.** `encumbrance.ts` documents the stance
   — "Capacity overruns don't block placement (guide, don't enforce)". Meters
   redden and the warning shows; `+` stays live. Only the *tier* cap disables
   `+`, which is how single items already behave.

## Design

### Cart representation

Replace `selected: Set<string>` with `cart: Map<string, number>` — item id to
quantity, with an absent key meaning "not taken". `toEntries` emits **one**
`EquipmentEntry` per item id carrying the aggregate quantity, not N entries, so
the existing stack-aware `slotsFor` math applies unchanged. Rehydration from
`$wizard.character.equipment` aggregates quantities by item id, so leaving the
step and returning preserves what was chosen.

Rejected alternative: one entry per copy. It would allow one dagger in hand and
another on the belt, but `autoPlace` already owns placement, and per-copy
entries complicate tier counting and the item grid for a case nobody asked for.
`GearEdit` can still split a stack after creation.

The pure cart helpers — aggregate from entries, step a quantity, count a tier,
build entries — move into `src/lib/engine/market-cart.ts` so they are unit
testable without a DOM, following the existing engine convention (pure, no UI
or DB imports).

### Item card UI

A taken card shows a stepper beside its checkmark: `☑ Dagger  − 2 +`. Clicking
an untaken card still takes one, so existing one-click behaviour is unchanged.
Stackables step by `stack.per` and label the real unit from `stack.unit` —
Arrows reads `×24 arrows`, not `×2`. Stepping down below the minimum — one unit for a
plain item, one full stack for a stackable — removes the item from the cart.

Talent-required items get the same stepper and never count against the
allowance, per "You can have as many as you want".

**Compatibility constraint:** `tests/e2e/wizard-smoke.test.ts` drives this step
with `page.getByRole('checkbox').first().click()`. The card must keep
`role="checkbox"` and its `aria-checked` state; the stepper buttons are separate
controls inside or beside the card, not a replacement for it.

### Allowance counting

`countInTier` sums quantities instead of counting entries. `atCap` becomes
"would one more copy exceed the tier cap", disabling `+` at 1 luxurious and
5 common. Impoverished (`null` cap) and talent-required items are never capped.

### Engine gap: two suits of armor

`autoPlace` maps entries 1:1 and wears the *entire* entry. With `quantity: 2`
light armor it would mark the whole entry `worn`, and `slotsFor` bills `worn`
entries at `def.wornBeltSlots` regardless of quantity — so the second suit would
ride free. Two suits of light armor is reachable under decision 1 (two of five
common picks).

Fix: `autoPlace` splits an armor entry with quantity > 1 into a worn entry of
quantity 1 plus a pack entry of quantity n−1. Its signature changes from `map`
to `flatMap`. `slotsFor` is unchanged — after the split, worn entries are always
quantity 1, and billing one suit's slots for a worn entry remains correct.

### Known limitation, deliberately not fixed

Three daggers (3 hand slots against a capacity of 2) are placed entirely on the
belt rather than two-in-hand and one-on-belt. `autoPlace` places a whole entry
in one location; splitting on partial fit is a larger rework than this issue
calls for, and players can rearrange in `GearEdit`.

### Ripple

- `GearEdit.svelte`: drop the `stack` gate on the quantity stepper so any item
  can be multiplied post-creation.
- `review/+page.svelte`: render `×N` in the Gear list, matching the sheet, PDF
  and markdown exports.
- No changes to `EquipmentEntry`, the Zod schema, migration, or the DB — all
  already carry `quantity`.
- No changes to `challenge-equipment.ts`; its `hasBow`/`hasShield` checks use
  `.some()` and are quantity-agnostic.

## Testing

- **Unit, `market-cart`:** aggregation from persisted entries; stepping up and
  down; removal at 1; stackable stepping by `stack.per`; tier counting summing
  quantities; `atCap` at the boundary.
- **Unit, `encumbrance`:** `autoPlace` splits 2× light armor into one worn and
  one packed entry; `loadSummary` over the split bills exactly one suit's belt
  slots. Existing `slotsFor` stack tests already cover the quantity math.
- **E2E, `wizard-smoke`:** take two of an item at the market, assert the review
  step shows `×2`, and assert the saved sheet shows `×2`.

## Out of scope

- Partial-fit placement across locations (see Known limitation).
- Any change to the market allowance values, which live in
  `static/content-packs/hmtw/index.json` and stay content-driven.
- Per-copy notch tracking. Notches remain per entry, as today.

[cart]: ../../../src/routes/create/hmtw/equipment/+page.svelte
[gate]: ../../../src/lib/components/character/edit/GearEdit.svelte
