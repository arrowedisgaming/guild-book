/**
 * Slot-based encumbrance. Capacities come from the content pack
 * (hands 2 / belt 4 / pack 21). Worn armor consumes its wornBeltSlots from the
 * BELT capacity; a second (and further) worn suit of the same armor bills its
 * full base slots per spare, since only one suit is ever actually worn — the
 * rest just rides along on the same entry. Other worn things (clothes, helms)
 * take no slots regardless of quantity. Oversized gear (carry: 'belt-only')
 * can never ride in the backpack. Stackables share a slot per their stack
 * rule (arrows 12/slot, lockpicks 6/slot…). Pure.
 */

import type { EquipmentEntry, CarryLocation } from '$lib/types/character';
import type { ItemDefinition, EncumbranceConfig } from '$lib/types/content-pack';

export type ItemIndex = Map<string, ItemDefinition>;

export function indexItems(items: ItemDefinition[]): ItemIndex {
	return new Map(items.map((i) => [i.id, i]));
}

/** Where the spares on a worn armor entry actually ride. */
function spareLocation(def: ItemDefinition | undefined): CarryLocation {
	return def?.carry === 'belt-only' ? 'belt' : 'pack';
}

/**
 * Slots one entry consumes at its current location, TOTAL — for a worn
 * armor entry this is the one worn suit's belt slots plus every spare's base
 * slots, added together. `loadSummary` is what divides that total between
 * the belt (the worn suit) and wherever the spares ride (`spareLocation`),
 * so the two stay in lockstep only if you don't change one without the
 * other.
 */
export function slotsFor(entry: EquipmentEntry, def: ItemDefinition | undefined): number {
	const baseSlots = def?.slots ?? entry.packSpace ?? 1;
	if (entry.location === 'worn') {
		// Worn armor bills its belt slots for the one suit actually worn, plus
		// its base slots for each spare riding along on the same entry.
		// Clothing and helms (no wornBeltSlots) stay free no matter the quantity.
		if (def?.wornBeltSlots == null) return 0;
		const spares = Math.max(0, entry.quantity - 1);
		return def.wornBeltSlots + spares * baseSlots;
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
		switch (entry.location) {
			case 'hand':
				hands += slotsFor(entry, def);
				break;
			case 'worn': {
				// Split a worn entry's total (see slotsFor) between the belt —
				// the one suit actually worn — and wherever the spares ride, so
				// this agrees with autoPlace regardless of who placed the entry.
				// Clothing and helms (no wornBeltSlots) stay free either way.
				const wornBeltSlots = def?.wornBeltSlots ?? 0;
				belt += wornBeltSlots;
				if (wornBeltSlots > 0 && entry.quantity > 1) {
					const baseSlots = def?.slots ?? entry.packSpace ?? 1;
					const spareSlots = (entry.quantity - 1) * baseSlots;
					if (spareLocation(def) === 'belt') belt += spareSlots;
					else pack += spareSlots;
				}
				break;
			}
			case 'belt':
				belt += slotsFor(entry, def);
				break;
			case 'pack':
				pack += slotsFor(entry, def);
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
 *  1. Armor (has wornBeltSlots) is worn — billed against the belt. Only ONE
 *     suit can be worn, so a multi-quantity armor entry is split: one worn,
 *     the spares packed.
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

	return entries.flatMap((entry): EquipmentEntry[] => {
		const def = entry.itemId ? items.get(entry.itemId) : undefined;
		const place = (location: CarryLocation): EquipmentEntry[] => [{ ...entry, location }];

		if (def?.wornBeltSlots && !wornArmor) {
			wornArmor = true; // wear the first suit of armor; spares ride per spareLocation
			beltUsed += def.wornBeltSlots;
			if (entry.quantity > 1) {
				// You can only wear one suit. Split so the belt is billed once and
				// the spares are honestly carried rather than silently free —
				// belt-only spares (contract: never in the pack) stay on the belt.
				const spareLoc = spareLocation(def);
				if (spareLoc === 'belt') {
					// Spares riding the belt (carry: 'belt-only' armor) must count
					// against beltUsed too, or a later hand-carried item consults a
					// stale counter and gets placed on an already-full belt.
					const baseSlots = def.slots ?? entry.packSpace ?? 1;
					beltUsed += (entry.quantity - 1) * baseSlots;
				}
				return [
					{ ...entry, location: 'worn', quantity: 1 },
					{ ...entry, location: spareLoc, quantity: entry.quantity - 1 }
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
}
