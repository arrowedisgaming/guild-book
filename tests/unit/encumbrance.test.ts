import { describe, it, expect } from 'vitest';
import { slotsFor, loadSummary, autoPlace, indexItems } from '$lib/engine/encumbrance';
import { getItems, getContentPack } from '$lib/server/content/loader';
import type { EquipmentEntry } from '$lib/types/character';
import type { ItemDefinition } from '$lib/types/content-pack';

const items = indexItems(getItems());
const caps = getContentPack().encumbrance;

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

describe('slotsFor', () => {
	it('bills a plain item its base slots', () => {
		expect(slotsFor(entry('rope'), items.get('rope'))).toBe(1);
		expect(slotsFor(entry('bedroll'), items.get('bedroll'))).toBe(2);
	});

	it('rounds stackables up per stack rule (arrows: 12 per slot)', () => {
		expect(slotsFor(entry('arrows', { quantity: 12 }), items.get('arrows'))).toBe(1);
		expect(slotsFor(entry('arrows', { quantity: 13 }), items.get('arrows'))).toBe(2);
		expect(slotsFor(entry('lockpicks', { quantity: 6 }), items.get('lockpicks'))).toBe(1);
	});

	it('multiplies non-stackables by quantity', () => {
		expect(slotsFor(entry('rations', { quantity: 3 }), items.get('rations'))).toBe(3);
	});

	it('bills worn armor its belt slots and other worn gear nothing', () => {
		expect(slotsFor(entry('armor-steel', { location: 'worn' }), items.get('armor-steel'))).toBe(3);
		expect(slotsFor(entry('armor-light', { location: 'worn' }), items.get('armor-light'))).toBe(1);
		expect(slotsFor(entry('helm', { location: 'worn' }), items.get('helm'))).toBe(0);
		expect(slotsFor(entry('clothes-common', { location: 'worn' }), items.get('clothes-common'))).toBe(0);
	});

	it('still bills a single worn suit its belt slots (regression: quantity 1)', () => {
		expect(
			slotsFor(entry('armor-light', { location: 'worn', quantity: 1 }), items.get('armor-light'))
		).toBe(1);
	});

	it('bills worn spares their base slots on top of the belt slots', () => {
		// armor-light: wornBeltSlots 1, slots 1 → 1 + 2*1 = 3 at quantity 3
		expect(
			slotsFor(entry('armor-light', { location: 'worn', quantity: 3 }), items.get('armor-light'))
		).toBe(3);
		// armor-steel: wornBeltSlots 3, slots 3 → 3 + 1*3 = 6 at quantity 2
		expect(
			slotsFor(entry('armor-steel', { location: 'worn', quantity: 2 }), items.get('armor-steel'))
		).toBe(6);
	});

	it('leaves worn clothing free no matter the quantity', () => {
		expect(
			slotsFor(entry('clothes-common', { location: 'worn', quantity: 5 }), items.get('clothes-common'))
		).toBe(0);
	});
});

describe('loadSummary', () => {
	it('counts worn armor against the belt', () => {
		const s = loadSummary(
			[entry('armor-iron', { location: 'worn' }), entry('rope', { location: 'belt' })],
			items,
			caps
		);
		expect(s.belt.used).toBe(3); // 2 worn + 1 rope
		expect(s.belt.over).toBe(false);
	});

	it('flags belt overflow past 4 slots', () => {
		const s = loadSummary(
			[
				entry('armor-steel', { location: 'worn' }), // 3
				entry('pole-10ft', { location: 'belt' }) // 2 → 5 > 4
			],
			items,
			caps
		);
		expect(s.belt.used).toBe(5);
		expect(s.belt.over).toBe(true);
	});

	it('flags oversized gear stowed in the pack as a violation', () => {
		const s = loadSummary([entry('shovel', { location: 'pack' })], items, caps);
		expect(s.violations).toHaveLength(1);
		expect(s.violations[0].reason).toMatch(/belt/i);
	});
});

describe('worn-entry spare billing (GearEdit path, no autoPlace)', () => {
	// GearEdit lets a player raise a worn entry's quantity directly, with no
	// autoPlace pass. loadSummary must split that entry's billing itself —
	// one suit to the belt, the spares to wherever spareLocation says — so
	// this path agrees with autoPlace's split rather than dumping both suits
	// on the belt (see slotsFor's TOTAL vs loadSummary's split, FIX 2).
	it('bills armor-light at quantity 2 as one suit on the belt, one spare in the pack', () => {
		const s = loadSummary([entry('armor-light', { location: 'worn', quantity: 2 })], items, caps);
		expect(s.belt.used).toBe(1);
		expect(s.pack.used).toBe(1);
	});

	it('bills armor-steel at quantity 2 as one suit on the belt, one spare in the pack', () => {
		const s = loadSummary([entry('armor-steel', { location: 'worn', quantity: 2 })], items, caps);
		expect(s.belt.used).toBe(3);
		expect(s.pack.used).toBe(3);
	});

	it('leaves worn clothing free at any quantity — no belt, no pack billing', () => {
		const s = loadSummary([entry('clothes-common', { location: 'worn', quantity: 5 })], items, caps);
		expect(s.belt.used).toBe(0);
		expect(s.pack.used).toBe(0);
	});

	it('agrees with autoPlace: both paths bill 2x armor-light identically', () => {
		const viaAutoPlace = loadSummary(
			autoPlace([entry('armor-light', { quantity: 2 })], items, caps),
			items,
			caps
		);
		const viaGearEdit = loadSummary(
			[entry('armor-light', { location: 'worn', quantity: 2 })],
			items,
			caps
		);
		expect(viaGearEdit.belt.used).toBe(viaAutoPlace.belt.used);
		expect(viaGearEdit.pack.used).toBe(viaAutoPlace.pack.used);
	});
});

describe('worn spares respect carry: belt-only (FIX 3, latent — no content-pack item does this today)', () => {
	const beltOnlyArmor: ItemDefinition = {
		id: 'synthetic-belt-only-armor',
		name: 'Synthetic Belt-Only Armor',
		tier: 'common',
		category: 'armor',
		description: 'A test fixture: worn armor that is also oversized.',
		slots: 2,
		carry: 'belt-only',
		wornBeltSlots: 1
	};
	const synthItems = indexItems([beltOnlyArmor]);
	function synthEntry(overrides: Partial<EquipmentEntry> = {}): EquipmentEntry {
		return {
			itemId: beltOnlyArmor.id,
			customName: null,
			tier: beltOnlyArmor.tier,
			packSpace: beltOnlyArmor.slots ?? 1,
			location: 'pack',
			quantity: 1,
			notchesTaken: 0,
			...overrides
		};
	}

	it('autoPlace sends the spare to the belt, not the pack', () => {
		const placed = autoPlace([synthEntry({ quantity: 2 })], synthItems, caps);
		expect(placed).toHaveLength(2);
		expect(placed[0]).toMatchObject({ location: 'worn', quantity: 1 });
		expect(placed[1]).toMatchObject({ location: 'belt', quantity: 1 });
	});

	it('loadSummary bills the spare against the belt, not the pack', () => {
		const s = loadSummary([synthEntry({ location: 'worn', quantity: 2 })], synthItems, caps);
		// wornBeltSlots 1 (worn suit) + 2 slots (one spare, belt-only) = 3
		expect(s.belt.used).toBe(3);
		expect(s.pack.used).toBe(0);
	});
});

describe('autoPlace', () => {
	it('wears armor, holds weapons, belts oversized gear, packs the rest', () => {
		const placed = autoPlace(
			[
				entry('armor-iron'),
				entry('weapon-blade'),
				entry('shield-light'),
				entry('pole-10ft'),
				entry('rations'),
				entry('helm')
			],
			items,
			caps
		);
		const at = (id: string) => placed.find((e) => e.itemId === id)?.location;
		expect(at('armor-iron')).toBe('worn');
		expect(at('weapon-blade')).toBe('hand');
		expect(at('shield-light')).toBe('hand');
		expect(at('pole-10ft')).toBe('belt');
		expect(at('rations')).toBe('pack');
		expect(at('helm')).toBe('worn');
	});

	it('overflows the third hand-carried item to the belt', () => {
		const placed = autoPlace(
			[entry('weapon-blade'), entry('weapon-dagger'), entry('weapon-axe')],
			items,
			caps
		);
		expect(placed.filter((e) => e.location === 'hand')).toHaveLength(2);
		expect(placed[2].location).toBe('belt');
	});

	it('wears only the first suit of armor; spares travel in the pack', () => {
		const placed = autoPlace([entry('armor-light'), entry('armor-steel')], items, caps);
		expect(placed[0].location).toBe('worn');
		expect(placed[1].location).toBe('pack');
	});

	describe('autoPlace with multiple suits of armor', () => {
		it('wears one suit and packs the spare', () => {
			const placed = autoPlace([entry('armor-light', { quantity: 2 })], items, caps);
			expect(placed).toHaveLength(2);
			expect(placed[0]).toMatchObject({ itemId: 'armor-light', location: 'worn', quantity: 1 });
			expect(placed[1]).toMatchObject({ itemId: 'armor-light', location: 'pack', quantity: 1 });
		});

		it('bills only the worn suit against the belt', () => {
			const placed = autoPlace([entry('armor-light', { quantity: 2 })], items, caps);
			const load = loadSummary(placed, items, caps);
			expect(load.belt.used).toBe(1); // one suit's wornBeltSlots, not two
			expect(load.pack.used).toBe(1); // the spare, at its 1 base slot
		});

		it('leaves a single suit as one worn entry', () => {
			const placed = autoPlace([entry('armor-light')], items, caps);
			expect(placed).toHaveLength(1);
			expect(placed[0]).toMatchObject({ location: 'worn', quantity: 1 });
		});

		it('still packs non-armor multiples as one entry', () => {
			const placed = autoPlace([entry('rations', { quantity: 3 })], items, caps);
			expect(placed).toHaveLength(1);
			expect(placed[0]).toMatchObject({ location: 'pack', quantity: 3 });
		});
	});
});
