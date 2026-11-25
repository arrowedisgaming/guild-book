<script lang="ts">
	import { tick, untrack } from 'svelte';
	import type { GuildBookCharacterData, CarryLocation, EquipmentEntry } from '$lib/types/character';
	import type { ItemDefinition, EncumbranceConfig } from '$lib/types/content-pack';
	import { indexItems, loadSummary, autoPlace, type LocationLoad } from '$lib/engine/encumbrance';
	import { stepSize } from '$lib/engine/market-cart';
	import CustomItemForm from './CustomItemForm.svelte';
	import FuzzyPicker from '$lib/components/ui/FuzzyPicker.svelte';
	import { Backpack, Hand, Shirt } from '@lucide/svelte';
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

	// The custom-item form stays typable through a save, so typing in it is
	// never cut off by the autosave of an earlier change. Only its submit waits
	// for the save: an entry appended mid-save would be dropped if that save
	// ended in a resync.
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

	// The market list for the type-to-filter box; the tier is searchable too.
	const marketOptions = $derived(items.map((it) => ({ id: it.id, label: it.name, detail: it.tier })));
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
	/** Tapping an empty box notches up to it; tapping a marked one repairs from it. */
	function tapNotch(i: number, box: number) {
		const e = char.equipment[i];
		const max = durabilityOf(e, defFor(e.itemId)) ?? 99;
		const next = box < e.notchesTaken ? box : box + 1;
		char.equipment[i] = { ...e, notchesTaken: Math.min(max, Math.max(0, next)) };
		onChange();
	}

	// Rows read as one line; a row's less-used controls (where it is carried,
	// Remove) open beneath it. Keyed by index into char.equipment, so a removal
	// — which shifts every later index — closes them all.
	let openRows = $state<number[]>([]);
	function toggleRow(i: number) {
		openRows = openRows.includes(i) ? openRows.filter((x) => x !== i) : [...openRows, i];
	}
	// A wholesale replacement of the working copy (undo, a resync, another
	// adventurer) leaves the indices pointing at different items.
	$effect(() => {
		void char;
		openRows = [];
	});
	/** Stacks are counted during play, so their − and + stay on the row itself. */
	function countsInline(e: EquipmentEntry) {
		const def = defFor(e.itemId);
		return e.quantity > 1 || (def ? stepSize(def) > 1 : false);
	}
	async function remove(i: number) {
		openRows = [];
		char.equipment = char.equipment.filter((_, idx) => idx !== i);
		onChange();
		// Rows are keyed by index, so the DOM node holding focus is reused for the
		// next item. Park focus on a stable control instead of a different item's.
		await tick();
		const stable = root?.querySelector('.add input');
		if (stable instanceof HTMLElement) stable.focus();
	}
	function add(itemId: string) {
		const def = itemIndex.get(itemId);
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
		openRows = [];
		char.equipment = autoPlace(char.equipment, itemIndex, encumbrance);
		onChange();
	}
</script>

{#snippet quantity(index: number, name: string)}
	<span class="ctrl">
		<button type="button" disabled={busy} data-entry-index={index} data-ctl="qty-dec" onclick={() => stepQty(index, -1)} aria-label={`Remove one ${name}`}>−</button>
		<button type="button" disabled={busy} data-entry-index={index} data-ctl="qty-inc" onclick={() => stepQty(index, 1)} aria-label={`Add one ${name}`}>+</button>
	</span>
{/snippet}

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
				<span class="gicon" aria-hidden="true">
					{#if group.id === 'hand'}
						<Hand size={20} strokeWidth={1.6} />
					{:else if group.id === 'worn'}
						<Shirt size={20} strokeWidth={1.6} />
					{:else if group.id === 'belt'}
						<!-- A strap and its buckle; drawn to match the set's stroke. -->
						<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
							<path d="M2 9.5h6M16 9.5h6M2 14.5h6M16 14.5h6" />
							<rect x="8" y="7" width="8" height="10" rx="1.2" />
							<path d="M12 12h5.5" />
						</svg>
					{:else}
						<Backpack size={20} strokeWidth={1.6} />
					{/if}
				</span>
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
						{@const isOpen = openRows.includes(row.index)}
						{@const inline = countsInline(e)}
						{@const detailId = `${uid}-row-${row.index}`}
						<li class="row" class:destroyed class:open={isOpen}>
							<div class="line">
								<button
									type="button"
									class="iname"
									disabled={busy}
									aria-expanded={isOpen}
									aria-controls={detailId}
									data-entry-index={row.index}
									data-ctl="toggle"
									onclick={() => toggleRow(row.index)}
								>
									<span class="itext">{name}{#if e.quantity > 1}&nbsp;×{e.quantity}{/if}</span>
									{#if e.spellComponent}<span class="tag">{e.spellComponent.spellName || 'Spell component'}</span>{/if}
									{#if destroyed}<span class="dead">Destroyed</span>{/if}
									<svg class="chevron" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
								</button>
								{#if dur !== null}
									<span class="notches" role="group" aria-label={`Notches on ${name}`}>
										<span class="sr-only">notches {e.notchesTaken}/{dur}</span>
										{#each { length: dur }, k (k)}
											<button
												type="button"
												class="notch"
												class:marked={k < e.notchesTaken}
												disabled={busy}
												aria-pressed={k < e.notchesTaken}
												aria-label={k < e.notchesTaken ? `Repair a notch on ${name}` : `Notch ${name}`}
												data-entry-index={row.index}
												data-ctl={`notch-${k}`}
												onclick={() => tapNotch(row.index, k)}
											></button>
										{/each}
									</span>
								{/if}
								{#if inline}
									{@render quantity(row.index, name)}
								{/if}
							</div>
							{#if isOpen}
								<div class="detail" id={detailId}>
									{#if !e.spellComponent}<span class="tag">{e.tier}</span>{/if}
									{#if e.location === 'worn' && def?.wornBeltSlots}<span class="tag">Takes {def.wornBeltSlots} belt slot{def.wornBeltSlots === 1 ? '' : 's'}</span>{/if}
									{#if e.spellComponent?.notes}<span class="notes">{e.spellComponent.notes}</span>{/if}
									<label class="carried">
										Carried
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
									</label>
									{#if !inline}
										<span class="count">Quantity {e.quantity} {@render quantity(row.index, name)}</span>
									{/if}
									<button type="button" class="remove" disabled={busy} data-entry-index={row.index} data-ctl="remove" onclick={() => remove(row.index)} aria-label={`Remove ${name}`}>Remove</button>
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/each}

	<div class="add">
		<FuzzyPicker
			options={marketOptions}
			label="Add an item from the market"
			placeholder="Add an item: type to search"
			disabled={busy}
			onPick={add}
		/>
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
		<CustomItemForm id={customFormId} disabled={locked} submitDisabled={saving} onAdd={addCustom} onCancel={() => (showCustom = false)} />
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
		color: var(--danger);
	}
	.group {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		min-width: 0;
	}
	/* Each carrying place opens with a grey band, as the book's tables do, so
	 * the four are told apart at a glance. */
	.ghead {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.3rem 0.6rem;
		margin-top: 0.5rem;
		padding: 0.35rem 0.6rem;
		border-top: 2px solid var(--ink);
		background: color-mix(in oklab, var(--ink) 9%, var(--parchment));
		font-family: var(--font-subhead);
	}
	.gicon {
		display: inline-flex;
		color: var(--ink);
	}
	h3 {
		margin: 0;
		min-width: 5.5rem;
		font-size: 1rem;
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
		background: var(--danger);
		border-color: var(--danger);
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
		color: var(--danger);
	}
	.empty {
		margin: 0;
		padding-left: 0.6rem;
		font-size: 0.85rem;
		font-style: italic;
		color: var(--ink-soft);
	}
	/* Two columns where there is room: a closed row is one short line, so the
	 * list is half as tall. An opened row takes the full width. */
	ul {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 17rem), 1fr));
		gap: 0.3rem 0.75rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.row {
		min-width: 0;
		border-bottom: 1px solid color-mix(in oklab, var(--ink) 14%, transparent);
		font-size: 0.9rem;
	}
	.row.open {
		grid-column: 1 / -1;
		border: 1px solid color-mix(in oklab, var(--ink) 22%, transparent);
		border-radius: 4px;
		padding: 0 0.6rem 0.5rem;
	}
	.row.destroyed .itext {
		text-decoration: line-through;
		color: var(--ink-soft);
	}
	.line {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 2.5rem;
	}
	.iname {
		flex: 1;
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0 0.4rem;
		min-width: 0;
		min-height: 2.5rem;
		padding: 0.2rem 0;
		border: none;
		background: none;
		color: var(--ink);
		font-family: var(--font-heading);
		font-size: 0.95rem;
		text-align: left;
		overflow-wrap: anywhere;
		cursor: pointer;
	}
	.iname:hover:not(:disabled) .itext {
		text-decoration: underline;
		text-decoration-color: var(--accent);
	}
	.iname:focus-visible,
	.notch:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.itext {
		font-variant-numeric: lining-nums;
	}
	.chevron {
		align-self: center;
		flex: none;
		color: var(--ink-soft);
	}
	.iname[aria-expanded='true'] .chevron {
		transform: rotate(180deg);
	}
	.tag {
		font-family: var(--font-subhead);
		font-size: 0.8rem;
		color: var(--ink-soft);
	}
	.notes {
		flex: 1 0 100%;
		font-size: 0.85rem;
		color: var(--ink-soft);
		overflow-wrap: anywhere;
	}
	.dead {
		font-family: var(--font-subhead);
		font-size: 0.8rem;
		color: var(--danger);
	}
	/* Durability as boxes to mark off, the way a paper sheet tracks it. */
	.notches {
		display: inline-flex;
		flex-wrap: wrap;
	}
	/* The button is the hit area; the box is drawn inside it, so a finger gets
	 * 44px without the box itself growing. */
	.notch {
		display: grid;
		place-items: center;
		width: 1.9rem;
		height: 1.9rem;
		padding: 0;
		border: none;
		background: none;
		cursor: pointer;
	}
	.notch::before {
		content: '';
		box-sizing: border-box;
		width: 1.5rem;
		height: 1.5rem;
		border: 2px solid var(--ink);
		border-radius: 3px;
		background: color-mix(in oklab, var(--parchment) 85%, white);
	}
	.notch.marked::before {
		background:
			linear-gradient(to top right, transparent 43%, var(--danger) 43% 57%, transparent 57%),
			linear-gradient(to top left, transparent 43%, var(--danger) 43% 57%, transparent 57%),
			color-mix(in oklab, var(--danger) 10%, var(--parchment));
		border-color: var(--danger);
	}
	.detail {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 1rem;
		padding-top: 0.5rem;
		border-top: 1px solid color-mix(in oklab, var(--ink) 14%, transparent);
	}
	.carried,
	.count {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		font-family: var(--font-subhead);
		font-size: 0.85rem;
		color: var(--ink-soft);
		font-variant-numeric: lining-nums;
	}
	select {
		max-width: 100%;
		min-height: 2.25rem;
		padding: 0.3rem 0.45rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 3px;
		background: var(--parchment);
		color: var(--ink);
		font: inherit;
		font-size: 0.9rem;
	}
	.ctrl {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}
	.ctrl button {
		width: 2rem;
		height: 2rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 3px;
		background: var(--parchment);
		color: var(--ink);
		font-size: 1rem;
		cursor: pointer;
	}
	.remove {
		margin-left: auto;
		min-height: 2.25rem;
		padding: 0.25rem 0.6rem;
		border: none;
		background: none;
		font-family: var(--font-subhead);
		font-size: 0.85rem;
		color: var(--ink-soft);
		text-decoration: underline;
		cursor: pointer;
	}
	.add {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 0.25rem;
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
	/* Fingers need 44px; a mouse keeps the denser list. */
	@media (pointer: coarse) {
		.ctrl button,
		.notch {
			width: 44px;
			height: 44px;
		}
		.iname,
		.line,
		select,
		.remove,
		.auto,
		.add button {
			min-height: 44px;
		}
	}
</style>
