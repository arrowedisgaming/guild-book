/**
 * Bond-type lookup for the adventurer sheet.
 *
 * A stored Bond keeps its type as the pack type's LABEL in `text` — that is
 * what the creation wizard writes, and `bonds.json` guarantees labels are as
 * unique as ids. A bond may also carry text the book never named, which
 * resolves to no type and simply has no charge conditions to show.
 */

import type { BondTypeDefinition } from '$lib/types/content-pack';

/** The pack type a bond's text names, or null when it names none. */
export function findBondType(
	types: readonly BondTypeDefinition[],
	text: string
): BondTypeDefinition | null {
	const wanted = text.trim().toLocaleLowerCase();
	if (!wanted) return null;
	return types.find((type) => type.label.trim().toLocaleLowerCase() === wanted) ?? null;
}

/** How the book says to charge this bond — empty for a bond with no pack type. */
export function bondChargeLines(
	types: readonly BondTypeDefinition[],
	text: string
): string[] {
	return findBondType(types, text)?.charge ?? [];
}

/** True when a bond carries text of the player's own, outside the pack's types. */
export function isCustomBondText(types: readonly BondTypeDefinition[], text: string): boolean {
	return text.trim() !== '' && findBondType(types, text) === null;
}
