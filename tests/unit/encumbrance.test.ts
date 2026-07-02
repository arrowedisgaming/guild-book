import { describe, it, expect } from 'vitest';
import { slotsFor, loadSummary, autoPlace, indexItems } from '$lib/engine/encumbrance';
import { getItems, getContentPack } from '$lib/server/content/loader';
import type { EquipmentEntry } from '$lib/types/character';

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
});
