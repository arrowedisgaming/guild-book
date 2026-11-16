<script lang="ts">
	import { tick, untrack } from 'svelte';
	import type { GuildBookCharacterData, CarryLocation, EquipmentEntry } from '$lib/types/character';
	import type { ItemDefinition, EncumbranceConfig } from '$lib/types/content-pack';
	import { indexItems, loadSummary, autoPlace, type LocationLoad } from '$lib/engine/encumbrance';
	import { stepSize } from '$lib/engine/market-cart';
	import CustomItemForm from './CustomItemForm.svelte';
	import { durabilityOf, fallbackItemName, groupGear, slotMeter } from '$lib/engine/gear-view';

	interface Props {
		char: GuildBookCharacterData;
		items: ItemDefinition[];
		encumbrance: EncumbranceConfig;
		onChange: () => void;
		/** The sheet is locked (recording XP, or a resync is required): nothing here is usable. */
		locked?: boolean;
		/** A save is in flight: the item rows, market add and Auto-arrange wait for it. */
		saving?: boolean;
	}
	let { char = $bindable(), items, encumbrance, onChange, locked = false, saving = false }: Props = $props();

	// The custom-item form stays usable through a save, so typing in it is never
	// cut off by the autosave of an earlier change: appending an entry while a
	// save is in flight is safe (the page snapshots and chains its saves).
	const busy = $derived(locked || saving);

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
	let customToggle: HTMLButtonElement | undefined = $state();
	const uid = $props.id();
	const customFormId = `${uid}-custom-item`;

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
		return e.customName ?? defFor(e.itemId)?.name ?? fallbackItemName(e.itemId);
	}

	// Disabling a focused control drops focus to <body>. Note what had focus as
	// the panel's controls are disabled, and put it back when they are enabled
	// again. A row control's index alone is not durable (removals shift it), so
	// its key also holds the list length and the entry's identity; no match at
	// restore time, no restore. Any other control (market select, Add,
	// Auto-arrange, the custom form while locked) is remembered as the element
	// itself and restored only if it is still in the document.
	type FocusKey =
		| { kind: 'row'; index: string; ctl: string; length: number; entry: string }
		| { kind: 'element'; el: HTMLElement };
	const fingerprint = (e: EquipmentEntry | undefined) =>
		e ? JSON.stringify([e.itemId, e.customName, e.tier, e.packSpace, e.location]) : '';
	let focusKey: FocusKey | null = null;
	$effect.pre(() => {
		if (!busy) return;
		// Only the transition into busy matters; nothing read below may re-run this.
		untrack(() => {
			const active = document.activeElement;
			if (!(active instanceof HTMLElement) || !root?.contains(active)) {
				focusKey = null;
			} else if (active.dataset.entryIndex) {
				focusKey = {
					kind: 'row',
					index: active.dataset.entryIndex,
					ctl: active.dataset.ctl ?? '',
					length: char.equipment.length,
					entry: fingerprint(char.equipment[Number(active.dataset.entryIndex)])
				};
			} else {
				focusKey = { kind: 'element', el: active };
			}
		});
	});
	$effect(() => {
		if (busy || !focusKey) return;
		const key = focusKey;
		focusKey = null;
		// Never steal focus the user has moved elsewhere.
		if (document.activeElement !== document.body) return;
		if (key.kind === 'element') {
			if (key.el.isConnected) key.el.focus();
			return;
		}
		if (
			char.equipment.length !== key.length ||
			fingerprint(char.equipment[Number(key.index)]) !== key.entry
		)
			return;
		const target = root?.querySelector(
			`[data-entry-index="${key.index}"][data-ctl="${key.ctl}"]`
		);
		if (target instanceof HTMLElement) target.focus();
	});

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
	async function remove(i: number) {
		char.equipment = char.equipment.filter((_, idx) => idx !== i);
		onChange();
		// Rows are keyed by index, so the DOM node holding focus is reused for the
		// next item. Park focus on a stable control instead of a different item's.
		await tick();
		const stable = root?.querySelector('.add select');
		if (stable instanceof HTMLElement) stable.focus();
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
	async function addCustom(entry: EquipmentEntry) {
		char.equipment = [...char.equipment, entry];
		showCustom = false;
		onChange();
		// The form (and the focused submit button) is gone; land on its toggle.
		await tick();
		customToggle?.focus();
	}
	function rearrange() {
		char.equipment = autoPlace(char.equipment, itemIndex, encumbrance);
		onChange();
	}
</script>

<section class="gear-panel" aria-labelledby="gear-heading" bind:this={root}>
	<div class="head">
		<h2 id="gear-heading">Gear</h2>
		<button type="button" class="auto" disabled={busy} onclick={rearrange}>Auto-arrange</button>
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
					<span class="meter" class:over={meter.over > 0} class:open={meter.over === 0 && meter.filled < gl.capacity}>{meter.status}</span>
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
								disabled={busy}
								data-entry-index={row.index}
								data-ctl="location"
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
								<button type="button" disabled={busy} data-entry-index={row.index} data-ctl="qty-dec" onclick={() => stepQty(row.index, -1)} aria-label={`Remove one ${name}`}>−</button>
								<button type="button" disabled={busy} data-entry-index={row.index} data-ctl="qty-inc" onclick={() => stepQty(row.index, 1)} aria-label={`Add one ${name}`}>+</button>
							</span>
							{#if dur !== null}
								<span class="ctrl">
									notches {e.notchesTaken}/{dur}
									<button type="button" disabled={busy} data-entry-index={row.index} data-ctl="notch-dec" onclick={() => stepNotch(row.index, -1)} aria-label={`Repair one notch on ${name}`}>−</button>
									<button type="button" disabled={busy} data-entry-index={row.index} data-ctl="notch-inc" onclick={() => stepNotch(row.index, 1)} aria-label={`Notch ${name}`}>+</button>
								</span>
							{/if}
							<button type="button" class="remove" disabled={busy} data-entry-index={row.index} data-ctl="remove" onclick={() => remove(row.index)} aria-label={`Remove ${name}`}>✕</button>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/each}

	<div class="add">
		<select bind:value={addId} disabled={busy} aria-label="Add an item from the market">
			<option value="">Add an item…</option>
			{#each ['impoverished', 'common', 'luxurious'] as tier (tier)}
				<optgroup label={tier}>
					{#each items.filter((it) => it.tier === tier) as it (it.id)}
						<option value={it.id}>{it.name}</option>
					{/each}
				</optgroup>
			{/each}
		</select>
		<button type="button" disabled={!addId || busy} onclick={add}>Add</button>
		<button
			type="button"
			class="custom-toggle"
			bind:this={customToggle}
			disabled={locked}
			aria-expanded={showCustom}
			aria-controls={customFormId}
			onclick={() => (showCustom = !showCustom)}>+ Custom item</button
		>
	</div>
	{#if showCustom}
		<CustomItemForm id={customFormId} disabled={locked} onAdd={addCustom} onCancel={() => (showCustom = false)} />
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
		gap: 4px;
		min-width: 0;
	}
	.slot {
		box-sizing: border-box;
		width: 1.15rem;
		height: 1.15rem;
		border: 2px solid var(--ink);
		border-radius: 3px;
		background: color-mix(in oklab, var(--parchment) 85%, white);
	}
	.slot.filled {
		background: color-mix(in oklab, var(--ink) 35%, var(--parchment));
		border-color: color-mix(in oklab, var(--ink) 35%, var(--parchment));
	}
	.boxes.over .slot.filled {
		background: var(--accent);
		border-color: var(--accent);
	}
	.meter {
		font-family: var(--font-subhead);
		font-size: 0.9rem;
		font-weight: 600;
		color: var(--ink-soft);
	}
	.meter.open {
		color: var(--ink);
	}
	.meter.over {
		color: var(--accent);
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
		flex: 1 1 14rem;
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
	.add button:disabled:not(.custom-toggle) {
		border-color: color-mix(in oklab, var(--ink) 30%, transparent);
		background: color-mix(in oklab, var(--ink) 15%, var(--parchment));
		color: var(--ink-soft);
		opacity: 1;
	}
	button:disabled,
	select:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
