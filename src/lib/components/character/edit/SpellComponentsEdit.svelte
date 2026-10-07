<script lang="ts">
 import type { GuildBookCharacterData } from '$lib/types/character';
 import type { GuildBookContentPack, SpellDefinition } from '$lib/types/content-pack';
 import { createSpellComponent } from '$lib/engine/spell-components';
 let { char = $bindable(), spells, config, onChange }: {
  char: GuildBookCharacterData; spells: SpellDefinition[]; config: GuildBookContentPack['sorcery']; onChange: () => void;
 } = $props();
 let spellId = $state('');
 let description = $state('');
 let spellName = $state('');
 let notes = $state('');
 let error = $state('');
 const selected = $derived(spells.find(s => s.id === spellId));
 function choose(id: string) {
  spellId = id;
  const spell = spells.find(s => s.id === id);
  description = spell?.component ?? '';
  spellName = spell?.name ?? '';
 }
 function add() {
  try {
   char.equipment = [...char.equipment, createSpellComponent({ description, spellId: spellId || null, spellName, notes }, config)];
   choose(''); notes = ''; error = ''; onChange();
  } catch (e) { error = e instanceof Error ? e.message : 'Could not add component.'; }
 }
 function convert(index: number) {
  const old = char.equipment[index];
  const component = createSpellComponent({ description: old.customName ?? '', spellId: null, spellName: '', notes: '' }, config);
  char.equipment[index] = { ...component, quantity: old.quantity, location: old.location === 'worn' ? 'pack' : old.location };
  onChange();
 }
</script>

<section aria-label="Spell components">
 <h3>Spell components</h3>
 <p class="hint">Components are reusable: each takes {config.componentSlots} pack slot{config.componentSlots === 1 ? '' : 's'}. Casting does not consume them. Agree substitutions with your GM.</p>
 {#each char.equipment as entry, i (i)}
  {#if entry.spellComponent}
   {@const canonical = spells.find(s => s.id === entry.spellComponent?.spellId)}
   <fieldset>
    <legend>{entry.spellComponent.spellName || 'Custom component'}</legend>
    <label>Component description<textarea maxlength="2000" bind:value={entry.customName} oninput={onChange}></textarea></label>
    <label>Spell name<input maxlength="200" bind:value={entry.spellComponent.spellName} oninput={onChange} /></label>
    <label>Component notes<textarea maxlength="4000" bind:value={entry.spellComponent.notes} oninput={onChange}></textarea></label>
    {#if canonical && canonical.component !== entry.customName}<p class="hint">Book component: {canonical.component}</p>{/if}
    <p class="hint">Quantity and carrying location are tracked in Gear above.</p>
   </fieldset>
  {:else if !entry.itemId && entry.customName}
   <button type="button" onclick={() => convert(i)}>Track {entry.customName} as a spell component</button>
  {/if}
 {/each}
 <form onsubmit={(event) => { event.preventDefault(); add(); }}>
  <label>Spell<select aria-label="Spell" value={spellId} onchange={e => choose(e.currentTarget.value)}>
   <option value="">Custom spell or unlinked component</option>
   {#each spells as spell}<option value={spell.id}>{spell.name} · {spell.tradition}</option>{/each}
  </select></label>
  {#if selected}<p class="hint">Book component: {selected.component}</p>{/if}
  <label>Component description<textarea required maxlength="2000" bind:value={description}></textarea></label>
  <label>Custom spell name<input maxlength="200" bind:value={spellName} /></label>
  <label>Acquisition notes<textarea maxlength="4000" bind:value={notes}></textarea></label>
  <button type="submit" disabled={!description.trim()}>Add spell component</button>
 </form>
 {#if error}<p role="alert">{error}</p>{/if}
</section>
<style>
 section { margin-top: 1.25rem; }
 form, fieldset { display: grid; gap: .6rem; margin: .75rem 0; }
 fieldset { border: 1px solid color-mix(in oklch, var(--ink) 25%, transparent); min-width: 0; }
 label { display: grid; gap: .25rem; font-size: .9rem; }
 input, select, textarea { width: 100%; min-width: 0; box-sizing: border-box; padding: .5rem; font: inherit; color: var(--ink); background: var(--parchment); border: 1px solid color-mix(in oklch, var(--ink) 25%, transparent); border-radius: 3px; }
 textarea { min-height: 4rem; resize: vertical; }
 button { justify-self: start; padding: .5rem .8rem; font: inherit; color: var(--parchment); background: var(--accent); border: 0; border-radius: 3px; cursor: pointer; }
 button:disabled { opacity: .5; cursor: default; }
 .hint { font-size: .85rem; color: var(--ink-soft); overflow-wrap: anywhere; }
</style>
