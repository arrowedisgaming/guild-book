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
