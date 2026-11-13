<script lang="ts">
	import { tick } from 'svelte';
	import type { GuildBookCharacterData, CarryLocation, EquipmentEntry } from '$lib/types/character';
	import type { ItemDefinition, EncumbranceConfig } from '$lib/types/content-pack';
	import { indexItems, loadSummary, autoPlace, type LocationLoad } from '$lib/engine/encumbrance';
	import { stepSize } from '$lib/engine/market-cart';
	import CustomItemForm from './CustomItemForm.svelte';
	import { durabilityOf, groupGear, slotMeter } from '$lib/engine/gear-view';

	interface Props {
		char: GuildBookCharacterData;
		items: ItemDefinition[];
		encumbrance: EncumbranceConfig;
		onChange: () => void;
	}
	let { char = $bindable(), items, encumbrance, onChange }: Props = $props();

	const itemIndex = $derived(indexItems(items));
	const load = $derived(loadSummary(char.equipment, itemIndex, encumbrance));
	// Display-only grouping: every row keeps its index into char.equipment, and
	// all mutations address the stored array by that index.
	const groups = $derived(groupGear(char.equipment));
	// Worn has no capacity of its own (worn armor draws on the belt).
	const groupLoad = $derived<Partial<Record<CarryLocation, LocationLoad>>>({
		hand: load.hands,
		belt: load.belt,
		pack: load.pack
	});

	let addId = $state('');
	let showCustom = $state(false);
	let root: HTMLElement | undefined = $state();

	const LOCATIONS: { id: CarryLocation; label: string }[] = [
		{ id: 'hand', label: 'Hand' },
		{ id: 'belt', label: 'Belt' },
		{ id: 'pack', label: 'Pack' },
		{ id: 'worn', label: 'Worn' }
	];

	function defFor(itemId: string | null) {
		return itemId ? itemIndex.get(itemId) : undefined;
	}
	function displayName(e: EquipmentEntry) {
		return e.customName ?? defFor(e.itemId)?.name ?? 'Item';
	}

	async function setLocation(i: number, location: CarryLocation) {
		char.equipment[i] = { ...char.equipment[i], location };
		onChange();
		// The row re-renders in its new group; keep keyboard focus with it.
		await tick();
		const select = root?.querySelector(`select[data-entry-index="${i}"]`);
		if (select instanceof HTMLElement) select.focus();
	}
	function stepQty(i: number, delta: number) {
		const e = char.equipment[i];
		// The sheet is the play surface — step by ONE unit at a time ("I shot
		// three arrows"), never by the market stack size. Use the ✕ button to
		// remove an item outright.
		char.equipment[i] = { ...e, quantity: Math.max(1, e.quantity + delta) };
		onChange();
	}
	function stepNotch(i: number, delta: number) {
		const e = char.equipment[i];
		const max = durabilityOf(e, defFor(e.itemId)) ?? 99;
		char.equipment[i] = { ...e, notchesTaken: Math.min(max, Math.max(0, e.notchesTaken + delta)) };
		onChange();
	}
	function remove(i: number) {
		char.equipment = char.equipment.filter((_, idx) => idx !== i);
		onChange();
	}
	function add() {
		const def = itemIndex.get(addId);
		if (!def) return;
		char.equipment = [
			...char.equipment,
			{
				itemId: def.id,
				customName: null,
				tier: def.tier,
				packSpace: def.slots ?? 1,
				location: 'pack',
				// Acquiring gear gives you a full stack, matching the market
				// (12 arrows, not 1).
				quantity: stepSize(def),
				notchesTaken: 0
			}
		];
		addId = '';
		onChange();
	}
	function addCustom(entry: EquipmentEntry) {
		char.equipment = [...char.equipment, entry];
		showCustom = false;
		onChange();
	}
	function rearrange() {
		char.equipment = autoPlace(char.equipment, itemIndex, encumbrance);
		onChange();
	}
</script>

<section class="gear-panel" aria-labelledby="gear-heading" bind:this={root}>
	<div class="head">
		<h2 id="gear-heading">Gear</h2>
		<button type="button" class="auto" onclick={rearrange}>Auto-arrange</button>
	</div>
	{#each load.violations as v}
		<p class="violation">{v.reason}</p>
	{/each}

	{#each groups as group (group.id)}
		{@const gl = groupLoad[group.id]}
		{@const meter = gl ? slotMeter(gl, group.label) : undefined}
		<section class="group" aria-label={meter?.text ?? 'Worn'}>
			<div class="ghead">
				<h3>{group.label}</h3>
				{#if gl && meter}
					<span class="boxes" class:over={meter.over > 0} aria-hidden="true">
						{#each { length: gl.capacity }, k (k)}
							<span class="slot" class:filled={k < meter.filled}></span>
						{/each}
					</span>
					<span class="meter" class:over={meter.over > 0}>{meter.status}</span>
				{/if}
			</div>
			{#if group.rows.length === 0}
				<p class="empty">empty</p>
			{:else}
				<ul>
					{#each group.rows as row (row.index)}
						{@const e = row.entry}
						{@const def = defFor(e.itemId)}
						{@const name = displayName(e)}
						{@const dur = durabilityOf(e, def)}
						{@const destroyed = dur !== null && e.notchesTaken >= dur}
						<li class="row" class:destroyed>
							<span class="iname">
								{name}{#if e.quantity > 1}&nbsp;×{e.quantity}{/if}
								{#if e.spellComponent}<span class="tag">{e.spellComponent.spellName || 'Spell component'}</span>{/if}
								{#if e.location === 'worn' && def?.wornBeltSlots}<span class="sub">· {def.wornBeltSlots} belt slot{def.wornBeltSlots === 1 ? '' : 's'}</span>{/if}
								{#if destroyed}<span class="dead">Destroyed</span>{/if}
							</span>
							<select
								data-entry-index={row.index}
								aria-label={`Location of ${name}`}
								value={e.location}
								onchange={(ev) => setLocation(row.index, ev.currentTarget.value as CarryLocation)}
							>
								{#each LOCATIONS.filter((l) => !e.spellComponent || l.id !== 'worn') as l (l.id)}
									<option value={l.id}>{l.label}</option>
								{/each}
							</select>
							<span class="ctrl">
								qty {e.quantity}
								<button type="button" onclick={() => stepQty(row.index, -1)} aria-label={`Remove one ${name}`}>−</button>
								<button type="button" onclick={() => stepQty(row.index, 1)} aria-label={`Add one ${name}`}>+</button>
							</span>
							{#if dur !== null}
								<span class="ctrl">
									notches {e.notchesTaken}/{dur}
									<button type="button" onclick={() => stepNotch(row.index, -1)} aria-label={`Repair one notch on ${name}`}>−</button>
									<button type="button" onclick={() => stepNotch(row.index, 1)} aria-label={`Notch ${name}`}>+</button>
								</span>
							{/if}
							<button type="button" class="remove" onclick={() => remove(row.index)} aria-label={`Remove ${name}`}>✕</button>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/each}

	<div class="add">
		<select bind:value={addId} aria-label="Add an item from the market">
			<option value="">Add an item…</option>
			{#each ['impoverished', 'common', 'luxurious'] as tier (tier)}
				<optgroup label={tier}>
					{#each items.filter((it) => it.tier === tier) as it (it.id)}
						<option value={it.id}>{it.name}</option>
					{/each}
				</optgroup>
			{/each}
		</select>
		<button type="button" disabled={!addId} onclick={add}>Add</button>
		<button type="button" class="custom-toggle" aria-expanded={showCustom} onclick={() => (showCustom = !showCustom)}>+ Custom item</button>
	</div>
	{#if showCustom}
		<CustomItemForm onAdd={addCustom} onCancel={() => (showCustom = false)} />
	{/if}
</section>

<style>
	.gear-panel {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		margin: 1.25rem 0;
		padding: 1rem 1.1rem;
		border: 1px solid color-mix(in oklab, var(--ink) 18%, transparent);
		border-radius: 4px;
		min-width: 0;
	}
	.head {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}
	h2 {
		margin: 0;
		font-size: 1.05rem;
	}
	.auto {
		margin-left: auto;
		padding: 0.25rem 0.7rem;
		border: 1px solid color-mix(in oklab, var(--accent) 60%, transparent);
		border-radius: 3px;
		background: transparent;
		color: var(--accent);
		font-family: var(--font-subhead);
		font-size: 0.8rem;
		cursor: pointer;
	}
	.violation {
		margin: 0;
		font-size: 0.8rem;
		color: var(--accent);
	}
	.group {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		min-width: 0;
	}
	.ghead {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.3rem 0.75rem;
		font-family: var(--font-subhead);
	}
	h3 {
		margin: 0;
		min-width: 5.5rem;
		font-size: 0.8rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.boxes {
		display: inline-flex;
		flex-wrap: wrap;
		gap: 3px;
		min-width: 0;
	}
	.slot {
		width: 0.7rem;
		height: 0.7rem;
		border: 1px solid color-mix(in oklab, var(--ink) 45%, transparent);
		border-radius: 2px;
	}
	.slot.filled {
		background: color-mix(in oklab, var(--ink) 70%, transparent);
		border-color: transparent;
	}
	.boxes.over .slot.filled {
		background: var(--accent);
	}
	.meter {
		font-size: 0.8rem;
		color: var(--ink-soft);
	}
	.meter.over {
		color: var(--accent);
		font-weight: 700;
	}
	.empty {
		margin: 0;
		padding-left: 0.6rem;
		font-size: 0.85rem;
		font-style: italic;
		color: var(--ink-soft);
	}
	ul {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.55rem;
		padding: 0.45rem 0.6rem;
		border: 1px solid color-mix(in oklab, var(--ink) 16%, transparent);
		border-radius: 4px;
		font-size: 0.9rem;
		min-width: 0;
	}
	.row.destroyed {
		opacity: 0.65;
	}
	.iname {
		font-family: var(--font-heading);
		overflow-wrap: anywhere;
		min-width: 0;
	}
	.tag,
	.sub {
		margin-left: 0.35rem;
		font-family: var(--font-subhead);
		font-size: 0.75rem;
		color: var(--ink-soft);
	}
	.dead {
		margin-left: 0.4rem;
		font-size: 0.68rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--accent);
		border: 1px solid color-mix(in oklab, var(--accent) 55%, transparent);
		border-radius: 999px;
		padding: 0.05rem 0.4rem;
	}
	select {
		max-width: 100%;
		padding: 0.3rem 0.45rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 3px;
		background: var(--parchment);
		color: var(--ink);
		font: inherit;
		font-size: 0.85rem;
	}
	.ctrl {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.8rem;
		color: var(--ink-soft);
	}
	.ctrl button {
		width: 1.4rem;
		height: 1.4rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 3px;
		background: var(--parchment);
		color: var(--ink);
		cursor: pointer;
	}
	.remove {
		margin-left: auto;
		border: none;
		background: none;
		color: var(--ink-soft);
		cursor: pointer;
	}
	.add {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 0.25rem;
		min-width: 0;
	}
	.add select {
		flex: 1;
		min-width: 0;
	}
	.add button {
		padding: 0.45rem 1rem;
		border: 1px solid var(--accent);
		border-radius: 3px;
		background: var(--accent);
		color: var(--parchment);
		font-family: var(--font-subhead);
		cursor: pointer;
	}
	.add .custom-toggle {
		border-color: color-mix(in oklab, var(--accent) 60%, transparent);
		background: transparent;
		color: var(--accent);
	}
	button:disabled,
	select:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
