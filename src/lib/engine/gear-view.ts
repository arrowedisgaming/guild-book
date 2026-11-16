/**
 * Pure helpers shared by the character view and the gear panel. No UI, DB,
 * or server imports.
 */

import type { EquipmentEntry, CarryLocation } from '$lib/types/character';
import type { ItemTier } from '$lib/types/common';
import type { LocationLoad } from '$lib/engine/encumbrance';
import type { ItemDefinition } from '$lib/types/content-pack';

/**
 * Notches an item can absorb before it is Destroyed. The catalogue value wins;
 * a custom item's own `customNotches` applies only when the catalogue gives none.
 */
export function durabilityOf(
	entry: EquipmentEntry,
	def: ItemDefinition | undefined
): number | null {
	return def?.notches ?? entry.customNotches ?? null;
}

export const GEAR_GROUPS: readonly { id: CarryLocation; label: string }[] = [
	{ id: 'hand', label: 'In hand' },
	{ id: 'worn', label: 'Worn' },
	{ id: 'belt', label: 'Belt' },
	{ id: 'pack', label: 'Backpack' }
];

export interface GearRow {
	entry: EquipmentEntry;
	/** Index into the stored equipment array. */
	index: number;
}

export interface GearGroup {
	id: CarryLocation;
	label: string;
	rows: GearRow[];
}

/** Groups entries by carry location for display; never mutates or re-indexes the input. */
export function groupGear(entries: EquipmentEntry[]): GearGroup[] {
	return GEAR_GROUPS.map((g) => ({
		...g,
		rows: entries.flatMap((entry, index) => (entry.location === g.id ? [{ entry, index }] : []))
	}));
}

export interface SlotMeter {
	filled: number;
	open: number;
	over: number;
	status: string;
	text: string;
}

export function slotMeter(load: LocationLoad, label: string): SlotMeter {
	const filled = Math.min(load.used, load.capacity);
	const open = Math.max(0, load.capacity - load.used);
	const over = Math.max(0, load.used - load.capacity);
	const spoken = over > 0 ? `${over} over` : open > 0 ? `${open} open` : 'full';
	// The visible label shows open slots against the total ("18/21 open").
	const status = over > 0 || open === 0 ? spoken : `${open}/${load.capacity} open`;
	return {
		filled,
		open,
		over,
		status,
		text: `${label}: ${load.used} of ${load.capacity} slots used, ${spoken}`
	};
}

export interface CustomItemInput {
	name: string;
	slots: number;
	quantity: number;
	tier: ItemTier;
	maxNotches: number | null;
}

export const CUSTOM_ITEM_LIMITS = { nameMax: 200, slotsMax: 21, notchesMax: 20 } as const;

/** Builds a packed custom entry; throws Error with a user-facing message on bad input. */
export function createCustomItem(input: CustomItemInput): EquipmentEntry {
	const name = input.name.trim();
	if (!name) throw new Error('Give the item a name.');
	if (name.length > CUSTOM_ITEM_LIMITS.nameMax) throw new Error('Name must be 200 characters or fewer.');
	if (!Number.isInteger(input.slots) || input.slots < 0 || input.slots > CUSTOM_ITEM_LIMITS.slotsMax)
		throw new Error('Slots must be a whole number from 0 to 21.');
	if (!Number.isInteger(input.quantity) || input.quantity < 1)
		throw new Error('Quantity must be a whole number of 1 or more.');
	const notches = input.maxNotches;
	if (
		notches !== null &&
		(!Number.isInteger(notches) || notches < 1 || notches > CUSTOM_ITEM_LIMITS.notchesMax)
	)
		throw new Error('Max notches must be a whole number from 1 to 20.');
	return {
		itemId: null,
		customName: name,
		tier: input.tier,
		packSpace: input.slots,
		location: 'pack',
		quantity: input.quantity,
		notchesTaken: 0,
		...(notches !== null ? { customNotches: notches } : {})
	};
}

/**
 * A readable name for an entry whose catalogue item no longer exists (ids
 * from an older content pack, e.g. `item-healers-kit`): the id with any
 * `item-` prefix dropped, dashes as spaces, first letter capitalised. Falls
 * back to "Item" when there is nothing to work from.
 */
export function fallbackItemName(itemId: string | null): string {
	const words = (itemId ?? '').replace(/^item-/, '').replace(/[-_]+/g, ' ').trim();
	return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Item';
}
