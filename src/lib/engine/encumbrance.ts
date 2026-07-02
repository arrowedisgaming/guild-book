/**
 * Slot-based encumbrance. Capacities come from the content pack
 * (hands 2 / belt 4 / pack 21). Worn armor consumes its wornBeltSlots from the
 * BELT capacity; other worn things (clothes, helms) take no slots. Oversized
 * gear (carry: 'belt-only') can never ride in the backpack. Stackables share a
 * slot per their stack rule (arrows 12/slot, lockpicks 6/slot…). Pure.
 */

import type { EquipmentEntry, CarryLocation } from '$lib/types/character';
import type { ItemDefinition, EncumbranceConfig } from '$lib/types/content-pack';

export type ItemIndex = Map<string, ItemDefinition>;

export function indexItems(items: ItemDefinition[]): ItemIndex {
	return new Map(items.map((i) => [i.id, i]));
}

/** Slots one entry consumes at its current location. */
export function slotsFor(entry: EquipmentEntry, def: ItemDefinition | undefined): number {
	const baseSlots = def?.slots ?? entry.packSpace ?? 1;
	if (entry.location === 'worn') {
		// Worn armor bills its belt slots; other worn gear is free.
		return def?.wornBeltSlots ?? 0;
	}
	const qty = Math.max(1, entry.quantity);
	const per = def?.stack?.per;
	// Stackables share a slot per `per` units; everything else is per-unit.
	const stacks = per && per > 0 ? Math.ceil(qty / per) : qty;
	return stacks * baseSlots;
}

export interface LocationLoad {
	used: number;
	capacity: number;
	over: boolean;
}

export interface LoadSummary {
	hands: LocationLoad;
	belt: LocationLoad;
	pack: LocationLoad;
	/** Entries breaking a placement rule (e.g. oversized gear in the pack). */
	violations: { entry: EquipmentEntry; reason: string }[];
}

/** Per-location usage. Worn armor counts against the belt. */
export function loadSummary(
	entries: EquipmentEntry[],
	items: ItemIndex,
	caps: EncumbranceConfig
): LoadSummary {
	let hands = 0;
	let belt = 0;
	let pack = 0;
	const violations: LoadSummary['violations'] = [];

	for (const entry of entries) {
		const def = entry.itemId ? items.get(entry.itemId) : undefined;
		const slots = slotsFor(entry, def);
		switch (entry.location) {
			case 'hand':
				hands += slots;
				break;
			case 'worn':
			case 'belt':
				belt += slots;
				break;
			case 'pack':
				pack += slots;
				if (def?.carry === 'belt-only') {
					violations.push({ entry, reason: `${def.name} is oversized — it can only ride on the belt.` });
				}
				break;
		}
	}

	return {
		hands: { used: hands, capacity: caps.handSlots, over: hands > caps.handSlots },
		belt: { used: belt, capacity: caps.beltSlots, over: belt > caps.beltSlots },
		pack: { used: pack, capacity: caps.packSlots, over: pack > caps.packSlots },
		violations
	};
}

/**
 * Deterministic rules-driven placement:
 *  1. Armor (has wornBeltSlots) is worn — billed against the belt.
 *  2. Helms and clothing are worn (free).
 *  3. Oversized (belt-only) gear goes to the belt.
 *  4. Hand-carried gear (weapons/shields) fills the hands, then the belt,
 *     then the pack.
 *  5. Everything else goes to the pack.
 * Capacity overruns don't block placement (guide, don't enforce) — they show
 * up in loadSummary as `over`.
 */
export function autoPlace(
	entries: EquipmentEntry[],
	items: ItemIndex,
	caps: EncumbranceConfig
): EquipmentEntry[] {
	let handUsed = 0;
	let beltUsed = 0;
	let wornArmor = false;

	return entries.map((entry) => {
		const def = entry.itemId ? items.get(entry.itemId) : undefined;
		const place = (location: CarryLocation): EquipmentEntry => ({ ...entry, location });

		if (def?.wornBeltSlots && !wornArmor) {
			wornArmor = true; // wear the first suit of armor; spares travel in the pack
			beltUsed += def.wornBeltSlots;
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
}
