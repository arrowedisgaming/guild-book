/**
 * Pure helpers shared by the character view and the gear panel. No UI, DB,
 * or server imports.
 */

import type { EquipmentEntry } from '$lib/types/character';
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
