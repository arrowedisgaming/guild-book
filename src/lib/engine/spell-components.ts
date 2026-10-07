import type { EquipmentEntry } from '$lib/types/character';
import type { GuildBookContentPack } from '$lib/types/content-pack';

/** Components share the gear inventory; quantity is physical objects, never spell charges. */
export function createSpellComponent(
 input: { description: string; spellId: string | null; spellName: string; notes: string },
 config: GuildBookContentPack['sorcery']
): EquipmentEntry {
 const description = input.description.trim();
 if (!description || description.length > 2000) throw new Error('Enter a component description (up to 2,000 characters).');
 if (input.spellName.trim().length > 200 || input.notes.trim().length > 4000) throw new Error('Spell name or notes are too long.');
 return {
  itemId: null, customName: description, tier: config.componentDefaultTier,
  packSpace: config.componentSlots, location: 'pack', quantity: 1, notchesTaken: 0,
  spellComponent: { spellId: input.spellId, spellName: input.spellName.trim(), notes: input.notes.trim() }
 };
}
