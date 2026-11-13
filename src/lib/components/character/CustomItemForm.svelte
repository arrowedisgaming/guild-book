<script lang="ts">
	import type { EquipmentEntry } from '$lib/types/character';
	import { ITEM_TIERS, type ItemTier } from '$lib/types/common';
	import { createCustomItem, CUSTOM_ITEM_LIMITS } from '$lib/engine/gear-view';

	interface Props {
		onAdd: (entry: EquipmentEntry) => void;
		onCancel: () => void;
		/** Element id, so the toggle that opens the form can point at it. */
		id?: string;
		/** Only while the sheet is locked (recording XP, resync); never for a save. */
		disabled?: boolean;
	}
	let { onAdd, onCancel, id, disabled = false }: Props = $props();

	let name = $state('');
	// Kept as strings so a fraction like "1.5" reaches the validator unchanged.
	let slots = $state('1');
	let quantity = $state('1');
	let tier = $state<ItemTier>('common');
	let notches = $state('');
	let error = $state('');

	// Number('') is 0, which would quietly pass as "0 slots". A blank field is
	// not a number: NaN lets the validator's own message explain it.
	const toNumber = (v: string) => (v.trim() === '' ? NaN : Number(v));

	function submit(ev: SubmitEvent) {
		ev.preventDefault();
		try {
			const entry = createCustomItem({
				name,
				slots: toNumber(slots),
				quantity: toNumber(quantity),
				tier,
				maxNotches: notches.trim() === '' ? null : Number(notches)
			});
			error = '';
			onAdd(entry);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not add that item.';
		}
	}
</script>

<form class="custom-form" {id} aria-label="Custom item" onsubmit={submit} novalidate>
	<label>
		<span>Item name</span>
		<input type="text" bind:value={name} maxlength={CUSTOM_ITEM_LIMITS.nameMax} autocomplete="off" {disabled} />
	</label>
	<div class="nums">
		<label>
			<span>Slots</span>
			<input type="text" inputmode="numeric" bind:value={slots} {disabled} />
		</label>
		<label>
			<span>Quantity</span>
			<input type="text" inputmode="numeric" bind:value={quantity} {disabled} />
		</label>
		<label>
			<span>Tier</span>
			<select bind:value={tier} {disabled}>
				{#each ITEM_TIERS as t (t)}
					<option value={t}>{t}</option>
				{/each}
			</select>
		</label>
		<label>
			<span>Max notches (optional)</span>
			<input type="text" inputmode="numeric" bind:value={notches} {disabled} />
		</label>
	</div>
	{#if error}<p class="error" role="alert">{error}</p>{/if}
	<div class="actions">
		<button type="submit" class="primary" {disabled}>Add custom item</button>
		<button type="button" onclick={onCancel} {disabled}>Cancel</button>
	</div>
</form>

<style>
	.custom-form {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		padding: 0.7rem 0.8rem;
		border: 1px solid color-mix(in oklab, var(--ink) 18%, transparent);
		border-radius: 4px;
		min-width: 0;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		min-width: 0;
		font-family: var(--font-subhead);
		font-size: 0.78rem;
		color: var(--ink-soft);
	}
	.nums {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr));
		gap: 0.6rem;
	}
	input,
	select {
		width: 100%;
		min-width: 0;
		box-sizing: border-box;
		padding: 0.35rem 0.5rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 3px;
		background: var(--parchment);
		color: var(--ink);
		font: inherit;
		font-size: 0.9rem;
	}
	.error {
		margin: 0;
		font-size: 0.85rem;
		color: var(--accent);
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	button {
		padding: 0.4rem 0.9rem;
		border: 1px solid color-mix(in oklab, var(--ink) 30%, transparent);
		border-radius: 3px;
		background: transparent;
		color: var(--ink);
		font-family: var(--font-subhead);
		cursor: pointer;
	}
	button.primary {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--parchment);
	}
</style>
