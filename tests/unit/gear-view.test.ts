import { describe, it, expect } from 'vitest';
import { indexItems, slotsFor } from '$lib/engine/encumbrance';
import {
	durabilityOf,
	groupGear,
	slotMeter,
	createCustomItem
} from '$lib/engine/gear-view';
import { equipmentEntrySchema } from '$lib/schemas/character.schema';
import { getItems, loadWizardData } from '$lib/server/content/loader';
import { createBlankCharacter } from '$lib/types/character';
import type { EquipmentEntry } from '$lib/types/character';
import { buildCharacterViewFromContent } from '$lib/character/view';

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
		const pushed = view.equipment[view.equipment.length - 1];
		expect(view.equipment).toHaveLength(char.equipment.length);
		expect(pushed.durability).toBe(2);
		expect(pushed.destroyed).toBe(true);
	});
});

describe('groupGear', () => {
	it('always returns the four groups in order', () =>
		expect(groupGear([]).map((g) => g.label)).toEqual(['In hand', 'Worn', 'Belt', 'Backpack']));
	it('keeps stored order within a group and carries original indices', () => {
		const list = [
			entry('rope'),
			entry('weapon-dagger', { location: 'hand' }),
			entry('torch'),
			entry('helm', { location: 'worn' })
		];
		const g = groupGear(list);
		expect(g[0].rows.map((r) => r.index)).toEqual([1]);
		expect(g[1].rows.map((r) => r.index)).toEqual([3]);
		expect(g[3].rows.map((r) => r.index)).toEqual([0, 2]);
		expect(g[3].rows[0].entry).toBe(list[0]);
	});
	it('does not mutate its input', () => {
		const list = [entry('rope')];
		groupGear(list);
		expect(list).toEqual([entry('rope')]);
	});
});

describe('slotMeter', () => {
	it('partly used', () =>
		expect(slotMeter({ used: 3, capacity: 4, over: false }, 'Belt')).toEqual({
			filled: 3,
			open: 1,
			over: 0,
			status: '1 open',
			text: 'Belt: 3 of 4 slots used, 1 open'
		}));
	it('full', () =>
		expect(slotMeter({ used: 2, capacity: 2, over: false }, 'In hand')).toMatchObject({
			filled: 2,
			open: 0,
			over: 0,
			status: 'full',
			text: 'In hand: 2 of 2 slots used, full'
		}));
	it('over', () =>
		expect(slotMeter({ used: 23, capacity: 21, over: true }, 'Backpack')).toMatchObject({
			filled: 21,
			open: 0,
			over: 2,
			status: '2 over',
			text: 'Backpack: 23 of 21 slots used, 2 over'
		}));
});

describe('createCustomItem', () => {
	const ok = { name: '  Jade idol ', slots: 1, quantity: 1, tier: 'common' as const, maxNotches: null };
	it('builds a packed custom entry with a trimmed name', () =>
		expect(createCustomItem(ok)).toEqual({
			itemId: null,
			customName: 'Jade idol',
			tier: 'common',
			packSpace: 1,
			location: 'pack',
			quantity: 1,
			notchesTaken: 0
		}));
	it('includes customNotches only when given', () => {
		expect(createCustomItem({ ...ok, maxNotches: 3 }).customNotches).toBe(3);
		expect('customNotches' in createCustomItem(ok)).toBe(false);
	});
	it('allows zero slots', () => expect(createCustomItem({ ...ok, slots: 0 }).packSpace).toBe(0));
	it('passes the character schema', () => {
		expect(equipmentEntrySchema.safeParse(createCustomItem(ok)).success).toBe(true);
		expect(equipmentEntrySchema.safeParse(createCustomItem({ ...ok, maxNotches: 3 })).success).toBe(true);
	});
	it('schema does not cap a long non-component name', () =>
		expect(equipmentEntrySchema.safeParse(custom({ customName: 'x'.repeat(500) })).success).toBe(true));
	it('costs zero slots at zero packSpace, and when worn', () => {
		expect(slotsFor(createCustomItem({ ...ok, slots: 0 }), undefined)).toBe(0);
		expect(slotsFor({ ...createCustomItem(ok), location: 'worn' }, undefined)).toBe(0);
	});
	it.each([
		[{ name: '   ' }, /name/i],
		[{ name: 'x'.repeat(201) }, /200/],
		[{ slots: -1 }, /slots/i],
		[{ slots: 22 }, /slots/i],
		[{ slots: 1.5 }, /slots/i],
		[{ quantity: 0 }, /quantity/i],
		[{ quantity: 2.5 }, /quantity/i],
		[{ maxNotches: 0 }, /notches/i],
		[{ maxNotches: 21 }, /notches/i]
	])('rejects %o', (patch, message) =>
		expect(() => createCustomItem({ ...ok, ...patch })).toThrow(message)
	);
});

describe('fallbackItemName', async () => {
	const { fallbackItemName } = await import('$lib/engine/gear-view');
	it('humanises an id from an older content pack', () => {
		expect(fallbackItemName('item-healers-kit')).toBe('Healers kit');
		expect(fallbackItemName('pole-10ft')).toBe('Pole 10ft');
	});
	it('falls back to "Item" with nothing to work from', () => {
		expect(fallbackItemName(null)).toBe('Item');
		expect(fallbackItemName('item-')).toBe('Item');
	});
});
