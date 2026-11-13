import { describe, it, expect } from 'vitest';
import { indexItems } from '$lib/engine/encumbrance';
import { durabilityOf } from '$lib/engine/gear-view';
import { getItems } from '$lib/server/content/loader';
import { createBlankCharacter } from '$lib/types/character';
import type { EquipmentEntry } from '$lib/types/character';
import { buildCharacterViewFromContent } from '$lib/character/view';
import { loadWizardData } from '$lib/server/content/loader';

const items = indexItems(getItems());

function entry(itemId: string, overrides: Partial<EquipmentEntry> = {}): EquipmentEntry {
	const def = getItems().find((i) => i.id === itemId)!;
	return {
		itemId,
		customName: null,
		tier: def.tier,
		packSpace: def.slots ?? 1,
		location: 'pack',
		quantity: 1,
		notchesTaken: 0,
		...overrides
	};
}

function custom(overrides: Partial<EquipmentEntry> = {}): EquipmentEntry {
	return {
		itemId: null,
		customName: 'Idol',
		tier: 'common',
		packSpace: 1,
		location: 'pack',
		quantity: 1,
		notchesTaken: 0,
		...overrides
	};
}

describe('durabilityOf', () => {
	it('uses the catalogue notches', () =>
		expect(durabilityOf(entry('helm'), items.get('helm'))).toBe(1));
	it('falls back to customNotches', () =>
		expect(durabilityOf(custom({ customNotches: 3 }), undefined)).toBe(3));
	it('is null with neither', () => expect(durabilityOf(custom(), undefined)).toBeNull());
	it('catalogue wins over a stray customNotches', () =>
		expect(durabilityOf({ ...entry('helm'), customNotches: 9 }, items.get('helm'))).toBe(1));
});

describe('buildCharacterView durability', () => {
	it('uses customNotches for custom items', () => {
		const char = createBlankCharacter();
		char.equipment.push(custom({ customNotches: 2, notchesTaken: 2 }));
		const view = buildCharacterViewFromContent(char, loadWizardData());
		expect(view.equipment[0].durability).toBe(2);
		expect(view.equipment[0].destroyed).toBe(true);
	});
});
