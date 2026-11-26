<script lang="ts">
	import type { GuildBookCharacterData } from '$lib/types/character';
	import type { GuildBookContentPack, SpellDefinition } from '$lib/types/content-pack';
	import { createSpellComponent } from '$lib/engine/spell-components';
	import FuzzyPicker from '$lib/components/ui/FuzzyPicker.svelte';

	let { char = $bindable(), spells, config, onChange }: {
		char: GuildBookCharacterData;
		spells: SpellDefinition[];
		config: GuildBookContentPack['sorcery'];
		onChange: () => void;
	} = $props();

	let spellId = $state('');
	let description = $state('');
	let spellName = $state('');
	let notes = $state('');
	let error = $state('');
	const uid = $props.id();
	const selected = $derived(spells.find((s) => s.id === spellId));
	const spellOptions = $derived(spells.map((s) => ({ id: s.id, label: s.name, detail: s.tradition })));

	function choose(id: string) {
		spellId = id;
		const spell = spells.find((s) => s.id === id);
		description = spell?.component ?? '';
		spellName = spell?.name ?? '';
	}
	function add() {
		try {
			char.equipment = [...char.equipment, createSpellComponent({ description, spellId: spellId || null, spellName, notes }, config)];
			choose('');
			notes = '';
			error = '';
			onChange();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not add component.';
		}
	}
	function convert(index: number) {
		const old = char.equipment[index];
		const component = createSpellComponent({ description: old.customName ?? '', spellId: null, spellName: '', notes: '' }, config);
		char.equipment[index] = { ...component, quantity: old.quantity, location: old.location === 'worn' ? 'pack' : old.location };
		onChange();
	}

	// One line per component, as in Gear; its fields open beneath it. Keyed by
	// index into char.equipment, so anything that reshuffles the list closes them.
	let openRows = $state<number[]>([]);
	function toggleRow(i: number) {
		openRows = openRows.includes(i) ? openRows.filter((x) => x !== i) : [...openRows, i];
	}
	$effect(() => {
		void char;
		void char.equipment.length;
		openRows = [];
	});
	const components = $derived(
		char.equipment.map((entry, index) => ({ entry, index })).filter((row) => row.entry.spellComponent)
	);
	const convertible = $derived(
		char.equipment
			.map((entry, index) => ({ entry, index }))
			.filter(({ entry }) => !entry.spellComponent && !entry.itemId && entry.customName && entry.customNotches === undefined)
	);
</script>

<section aria-label="Spell components">
	<p class="hint">Components are reusable: each takes {config.componentSlots} pack slot{config.componentSlots === 1 ? '' : 's'}. Casting does not consume them. Agree substitutions with your GM.</p>

	{#if components.length}
		<ul class="rows">
			{#each components as { entry, index } (index)}
				{@const component = entry.spellComponent!}
				{@const canonical = spells.find((s) => s.id === component.spellId)}
				{@const isOpen = openRows.includes(index)}
				{@const detailId = `${uid}-c-${index}`}
				<li class="row" class:open={isOpen}>
					<button type="button" class="line" aria-expanded={isOpen} aria-controls={detailId} onclick={() => toggleRow(index)}>
						<span class="cname">{entry.customName || 'Unnamed component'}</span>
						<span class="tag">{component.spellName || 'Custom component'}</span>
						<svg class="chevron" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
					</button>
					{#if isOpen}
						<div class="detail" id={detailId}>
							<label>Component description<textarea maxlength="2000" rows="2" bind:value={entry.customName} oninput={onChange}></textarea></label>
							<label>Spell name<input maxlength="200" bind:value={component.spellName} oninput={onChange} /></label>
							<label>Component notes<textarea maxlength="4000" rows="2" bind:value={component.notes} oninput={onChange}></textarea></label>
							{#if canonical && canonical.component !== entry.customName}<p class="hint">Book component: {canonical.component}</p>{/if}
							<p class="hint">Quantity, where it is carried and Remove are in Gear above.</p>
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}

	{#each convertible as { entry, index } (index)}
		<button type="button" class="convert" onclick={() => convert(index)}>Track {entry.customName} as a spell component</button>
	{/each}

	<details class="new">
		<summary>Add a spell component</summary>
		<form onsubmit={(event) => { event.preventDefault(); add(); }}>
			<div class="field">
				<span class="flabel">Spell</span>
				<FuzzyPicker options={spellOptions} label="Spell" placeholder="Type to search, or leave empty for a custom spell" value={spellId} onPick={choose} />
			</div>
			{#if selected}<p class="hint">Book component: {selected.component}</p>{/if}
			<label>Component description<textarea required maxlength="2000" rows="2" bind:value={description}></textarea></label>
			<label>Custom spell name<input maxlength="200" bind:value={spellName} /></label>
			<label>Acquisition notes<textarea maxlength="4000" rows="2" bind:value={notes}></textarea></label>
			<button type="submit" class="submit" disabled={!description.trim()}>Add spell component</button>
		</form>
	</details>
	{#if error}<p role="alert">{error}</p>{/if}
</section>

<style>
	section { margin-top: 0; }
	.hint { margin: 0; font-size: 0.85rem; color: var(--ink-soft); overflow-wrap: anywhere; }
	/* The same one-line rows as Gear, in two columns where there is room. */
	.rows {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 17rem), 1fr));
		gap: 0.3rem 0.75rem;
		margin: 0.75rem 0 0;
		padding: 0;
		list-style: none;
	}
	.row { min-width: 0; border-bottom: 1px solid color-mix(in oklab, var(--ink) 14%, transparent); }
	.row.open {
		grid-column: 1 / -1;
		border: 1px solid color-mix(in oklab, var(--ink) 22%, transparent);
		border-radius: 4px;
		padding: 0 0.6rem 0.6rem;
	}
	.line {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0 0.5rem;
		width: 100%;
		min-height: 2.5rem;
		padding: 0.2rem 0;
		border: none;
		background: none;
		color: var(--ink);
		text-align: left;
		cursor: pointer;
	}
	.line:hover .cname { text-decoration: underline; }
	.line:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
	.cname { font-family: var(--font-heading); font-size: 0.95rem; overflow-wrap: anywhere; }
	.tag { font-family: var(--font-subhead); font-size: 0.8rem; color: var(--ink-soft); }
	.chevron { align-self: center; flex: none; color: var(--ink-soft); }
	.line[aria-expanded='true'] .chevron { transform: rotate(180deg); }
	.detail, form { display: grid; gap: 0.6rem; }
	.detail { padding-top: 0.5rem; border-top: 1px solid color-mix(in oklab, var(--ink) 14%, transparent); }
	form { margin: 0.75rem 0 0; }
	label, .field { display: grid; gap: 0.25rem; font-size: 0.9rem; }
	input, textarea {
		width: 100%; min-width: 0; box-sizing: border-box; padding: 0.5rem; font: inherit;
		color: var(--ink); background: var(--parchment);
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent); border-radius: 3px;
	}
	textarea { resize: vertical; }
	.new { margin-top: 0.9rem; }
	summary { cursor: pointer; font-family: var(--font-subhead); color: var(--accent); }
	.submit, .convert {
		justify-self: start; min-height: 2.5rem; padding: 0.5rem 0.9rem; font: inherit;
		font-family: var(--font-subhead); border-radius: 3px; cursor: pointer;
	}
	.submit { color: var(--parchment); background: var(--accent); border: 1px solid var(--accent); }
	.convert { margin-top: 0.6rem; color: var(--accent); background: transparent; border: 1px solid color-mix(in oklab, var(--accent) 60%, transparent); }
	.submit:disabled { opacity: 0.5; cursor: default; }
	@media (pointer: coarse) {
		summary { display: flex; align-items: center; min-height: 44px; }
		input, .line, .submit, .convert { min-height: 44px; }
	}
</style>
