import { describe, expect, it } from 'vitest';
import { createSpellComponent } from '$lib/engine/spell-components';
import { loadSummary, autoPlace } from '$lib/engine/encumbrance';

describe('spell components as carried equipment', () => {
 const config = { componentSlots: 1, componentDefaultTier: 'impoverished' as const };
 const input = { description: 'Ash from the drowned chapel', spellId: null, spellName: 'Custom ward', notes: 'Prepared at camp' };
 const caps = { handSlots: 2, beltSlots: 4, packSlots: 21 };
 it('records custom details without requiring a catalogue item', () => {
  expect(createSpellComponent(input, config)).toMatchObject({ itemId: null, customName: input.description, packSpace: 1, quantity: 1, location: 'pack', spellComponent: { spellId: null, spellName: 'Custom ward', notes: 'Prepared at camp' } });
 });
 it('counts physical components, and moving them changes the correct load', () => {
  const e = createSpellComponent(input, config);
  expect(loadSummary([{ ...e, quantity: 2 }], new Map(), caps).pack.used).toBe(2);
  expect(loadSummary([{ ...e, location: 'hand' }], new Map(), caps).hands.used).toBe(1);
  expect(autoPlace([{ ...e, location: 'hand' }], new Map(), caps)[0].location).toBe('pack');
 });
 it('never allows components to become free by being worn', () => {
  const e = { ...createSpellComponent(input, config), location: 'worn' as const };
  const load = loadSummary([e], new Map(), caps);
  expect(load.violations).toHaveLength(1);
  expect(load.pack.used).toBe(1);
 });
 it('uses configured slots and rejects blank descriptions', () => {
  expect(createSpellComponent(input, { ...config, componentSlots: 2 }).packSpace).toBe(2);
  expect(() => createSpellComponent({ ...input, description: '  ' }, config)).toThrow();
 });
});
