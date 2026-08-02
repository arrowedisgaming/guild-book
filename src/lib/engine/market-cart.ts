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
 * `autoPlace` may have split one item across two locations. Then floor each
 * stackable's total up to at least one full stack: a wizard saved before
 * this release hardcoded `quantity: 1` for every item, so a legacy single
 * arrow needs to become a full quiver (12) — left at 1, the next `−` press
 * would fall below one step and `stepCart` would delete it outright. The
 * floor exists only to repair those legacy single-unit entries; anything
 * already at or above one full stack is taken at face value, because it may
 * be a legitimately depleted stack rather than legacy data (13 arrows stays
 * 13 — it is not rounded up to 24). Items with step 1, and unknown item
 * ids, are left exactly as summed. */
export function cartFromEntries(
	entries: readonly EquipmentEntry[],
	items: readonly ItemDefinition[]
): Map<string, number> {
	const defs = new Map(items.map((i) => [i.id, i]));
	const cart = new Map<string, number>();
	for (const entry of entries) {
		if (!entry.itemId) continue; // free-typed custom gear has no market id
		cart.set(entry.itemId, (cart.get(entry.itemId) ?? 0) + Math.max(1, entry.quantity));
	}
	for (const [itemId, quantity] of cart) {
		const step = stepSize(defs.get(itemId));
		if (step > 1) cart.set(itemId, Math.max(quantity, step));
	}
	return cart;
}

/** Add or drop one pick's worth. Upward adds a full step. Downward SNAPS to
 * the stack grid rather than subtracting a step, so a legitimately partial
 * stack (e.g. 13 arrows, left alone by `cartFromEntries`) steps down to the
 * nearest full stack below it (13 → 12) instead of dropping straight below
 * `step` and getting deleted by a single subtraction (13 − 12 = 1). Falling
 * to or below zero removes the item outright, so `−` on the last unit or
 * last partial stack un-takes it. Never mutates `cart`. */
export function stepCart(
	cart: MarketCart,
	itemId: string,
	def: ItemDefinition | undefined,
	delta: 1 | -1
): Map<string, number> {
	const next = new Map(cart);
	const step = stepSize(def);
	const current = next.get(itemId) ?? 0;
	if (delta === 1) {
		next.set(itemId, current + step);
		return next;
	}
	const quantity = Math.floor((current - 1) / step) * step;
	if (quantity <= 0) next.delete(itemId);
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
