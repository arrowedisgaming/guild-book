<script lang="ts">
	import type { GuildBookCharacterData, CarryLocation } from '$lib/types/character';
	import type { ItemDefinition, EncumbranceConfig } from '$lib/types/content-pack';
	import { indexItems, loadSummary, autoPlace } from '$lib/engine/encumbrance';

	interface Props {
		char: GuildBookCharacterData;
		items: ItemDefinition[];
		encumbrance: EncumbranceConfig;
		onChange: () => void;
	}
	let { char = $bindable(), items, encumbrance, onChange }: Props = $props();

	const itemIndex = $derived(indexItems(items));
	const load = $derived(loadSummary(char.equipment, itemIndex, encumbrance));

	let addId = $state('');

	const LOCATIONS: { id: CarryLocation; label: string }[] = [
		{ id: 'hand', label: 'Hand' },
		{ id: 'belt', label: 'Belt' },
		{ id: 'pack', label: 'Pack' },
		{ id: 'worn', label: 'Worn' }
	];

	function defFor(itemId: string | null) {
		return itemId ? itemIndex.get(itemId) : undefined;
	}
	function displayName(e: (typeof char.equipment)[number]) {
		return e.customName ?? defFor(e.itemId)?.name ?? 'Item';
	}
	function durability(e: (typeof char.equipment)[number]) {
		return defFor(e.itemId)?.notches ?? null;
	}

	function setLocation(i: number, location: CarryLocation) {
		char.equipment[i] = { ...char.equipment[i], location };
		onChange();
	}
	function stepQty(i: number, delta: number) {
		const e = char.equipment[i];
		char.equipment[i] = { ...e, quantity: Math.max(1, e.quantity + delta) };
		onChange();
	}
	function stepNotch(i: number, delta: number) {
		const e = char.equipment[i];
		const max = durability(e) ?? 99;
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
				quantity: 1,
				notchesTaken: 0
			}
		];
		addId = '';
		onChange();
	}
	function rearrange() {
		char.equipment = autoPlace(char.equipment, itemIndex, encumbrance);
		onChange();
	}
</script>

<div class="gear-edit">
	<div class="meters">
		{#each [{ k: 'hands', label: 'Hands' }, { k: 'belt', label: 'Belt' }, { k: 'pack', label: 'Pack' }] as m (m.k)}
			{@const loc = load[m.k as 'hands' | 'belt' | 'pack']}
			<span class="meter" class:over={loc.over}>{m.label} {loc.used}/{loc.capacity}</span>
		{/each}
		<button type="button" class="auto" onclick={rearrange}>Auto-arrange</button>
	</div>
	{#each load.violations as v}
		<p class="violation">{v.reason}</p>
	{/each}

	{#each char.equipment as e, i (i)}
		{@const dur = durability(e)}
		{@const destroyed = dur !== null && e.notchesTaken >= dur}
		<div class="row" class:destroyed>
			<span class="iname">
				{displayName(e)}{#if e.quantity > 1}&nbsp;×{e.quantity}{/if}
				{#if destroyed}<span class="dead">Destroyed</span>{/if}
			</span>
			<select value={e.location} onchange={(ev) => setLocation(i, ev.currentTarget.value as CarryLocation)}>
				{#each LOCATIONS as l (l.id)}
					<option value={l.id}>{l.label}</option>
				{/each}
			</select>
			{#if defFor(e.itemId)?.stack}
				<span class="ctrl">
					qty
					<button type="button" onclick={() => stepQty(i, -1)}>−</button>
					<button type="button" onclick={() => stepQty(i, 1)}>+</button>
				</span>
			{/if}
			{#if dur !== null}
				<span class="ctrl">
					notches {e.notchesTaken}/{dur}
					<button type="button" onclick={() => stepNotch(i, -1)}>−</button>
					<button type="button" onclick={() => stepNotch(i, 1)}>+</button>
				</span>
			{/if}
			<button type="button" class="remove" onclick={() => remove(i)} aria-label="Remove item">✕</button>
		</div>
	{/each}

	<div class="add">
		<select bind:value={addId}>
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
	</div>
</div>

<style>
	.gear-edit {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
	}
	.meters {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem;
		font-family: var(--font-subhead);
		font-size: 0.85rem;
	}
	.meter.over {
		color: var(--accent);
		font-weight: 700;
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
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.55rem;
		padding: 0.45rem 0.6rem;
		border: 1px solid color-mix(in oklab, var(--ink) 16%, transparent);
		border-radius: 4px;
		font-size: 0.9rem;
	}
	.row.destroyed {
		opacity: 0.65;
	}
	.iname {
		font-family: var(--font-heading);
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
		padding: 0.3rem 0.45rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 3px;
		background: var(--parchment);
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
		gap: 0.5rem;
		margin-top: 0.25rem;
	}
	.add select {
		flex: 1;
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
	.add button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
