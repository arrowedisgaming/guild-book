<script lang="ts">
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { wizard, WIZARD_STEPS } from '$lib/stores/wizard';
	import WizardNav from '$lib/components/wizard/WizardNav.svelte';
	import type { PageData } from './$types';

	const STEP = 6;
	let { data }: { data: PageData } = $props();

	const DEFAULT_TYPE = 'Ally';

	interface BondRow {
		targetName: string;
		type: string;
		charged: boolean;
	}

	let rows = $state<BondRow[]>(
		untrack(() =>
			$wizard.character.bonds.length
				? $wizard.character.bonds.map((b) => ({
						targetName: b.targetName,
						type: b.text || DEFAULT_TYPE,
						charged: b.charged
					}))
				: [{ targetName: '', type: DEFAULT_TYPE, charged: false }]
		)
	);

	const typeDescription = (label: string) =>
		data.bondTypes.find((t) => t.label === label)?.description ?? '';

	function persist() {
		wizard.updateCharacter((c) => ({
			...c,
			bonds: rows
				.filter((r) => r.targetName.trim())
				.map((r) => ({ targetName: r.targetName.trim(), text: r.type, charged: r.charged }))
		}));
	}

	function addRow() {
		rows = [...rows, { targetName: '', type: DEFAULT_TYPE, charged: false }];
	}

	function removeRow(i: number) {
		rows = rows.filter((_, idx) => idx !== i);
		persist();
	}

	function next() {
		persist();
		wizard.completeStep(STEP);
		goto(WIZARD_STEPS[STEP + 1].path);
	}
</script>

<svelte:head><title>Bonds — Guild Book</title></svelte:head>

<h1>Bonds</h1>
<p class="lede">
	Bonds are your relationships with the other members of your guild. Charge them by playing
	them to the hilt; burn charges at camp to heal Wounds and recover Resolve. Name a guild-mate
	and pick the Bond you share — or continue and forge them at the table.
</p>

<div class="bonds">
	{#each rows as row, i (i)}
		<div class="bond-row">
			<label>
				<span>Bond type</span>
				<select aria-label="Bond type" bind:value={row.type} onchange={persist}>
					{#each data.bondTypes as t (t.id)}
						<option value={t.label}>{t.label}</option>
					{/each}
				</select>
			</label>
			<label>
				<span>Guild-mate's name</span>
				<input
					type="text"
					aria-label="Guild-mate's name"
					bind:value={row.targetName}
					oninput={persist}
					placeholder="e.g. Grendel"
				/>
			</label>
			<button type="button" class="remove" onclick={() => removeRow(i)} aria-label="Remove bond">
				✕
			</button>
			{#if typeDescription(row.type)}
				<p class="hint">{typeDescription(row.type)}</p>
			{/if}
		</div>
	{/each}
</div>

<button type="button" class="add" onclick={addRow}>+ Add another bond</button>

<WizardNav backPath={WIZARD_STEPS[STEP - 1].path} onContinue={next} />

<style>
	.lede {
		color: var(--ink-soft);
		margin-top: -0.25rem;
	}
	.bonds {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		margin-top: 1.5rem;
	}
	.bond-row {
		display: grid;
		grid-template-columns: 1fr 1.5fr auto;
		gap: 0.75rem;
		align-items: end;
	}
	.bond-row label {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	.bond-row label span {
		font-family: var(--font-subhead);
		font-size: 0.9rem;
	}
	.bond-row .hint {
		grid-column: 1 / -1;
		margin: 0;
		color: var(--ink-soft);
		font-size: 0.85rem;
	}
	select,
	input {
		padding: 0.55rem 0.7rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 3px;
		background: var(--parchment);
		font: inherit;
	}
	.remove {
		padding: 0.45rem 0.7rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 3px;
		background: transparent;
		cursor: pointer;
	}
	.add {
		margin-top: 1rem;
		padding: 0.45rem 0.9rem;
		border: 1px dashed color-mix(in oklab, var(--ink) 35%, transparent);
		border-radius: 3px;
		background: transparent;
		font: inherit;
		cursor: pointer;
	}
	@media (max-width: 560px) {
		.bond-row {
			grid-template-columns: 1fr auto;
		}
	}
</style>
