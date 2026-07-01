<script lang="ts">
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { wizard, WIZARD_STEPS } from '$lib/stores/wizard';
	import { SUIT_IDS, SUIT_LABELS, type SuitId } from '$lib/types/common';
	import { assignAttributeSpread, buildAttributeStates } from '$lib/engine/attributes';
	import WizardNav from '$lib/components/wizard/WizardNav.svelte';
	import type { PageData } from './$types';

	const STEP = 3;
	let { data }: { data: PageData } = $props();

	const path = $derived(data.paths.find((p) => p.id === $wizard.character.pathId) ?? null);
	const pathSuit = $derived(path?.suit ?? null);

	const spread = $derived([...data.contentPack.creation.attributeSpread].sort((a, b) => b - a));
	const highest = $derived(spread[0]);
	const restValues = $derived(spread.slice(1)); // e.g. [3, 2, 1]

	const otherSuits = $derived(SUIT_IDS.filter((s) => s !== pathSuit));

	// Seed the assignment once from any prior values on the character.
	let assignment = $state<Record<string, number | null>>(
		untrack(() =>
			Object.fromEntries(
				otherSuits.map((s) => {
					const v = $wizard.character.attributes[s]?.value ?? 0;
					return [s, restValues.includes(v) ? v : null];
				})
			)
		)
	);

	let usedValues = $derived(Object.values(assignment).filter((v): v is number => v !== null));
	let isValid = $derived(
		usedValues.length === restValues.length && new Set(usedValues).size === restValues.length
	);

	function next() {
		if (!pathSuit || !isValid) return;
		const values = assignAttributeSpread({
			pathSuit,
			spread,
			otherSuits: [...otherSuits].sort(
				(a, b) => (assignment[b] ?? 0) - (assignment[a] ?? 0)
			) as SuitId[]
		});
		const states = buildAttributeStates(values, {
			pathSuit,
			pathLabel: path?.name ?? 'Path',
			at: new Date().toISOString()
		});
		wizard.updateCharacter((c) => ({ ...c, attributes: states }));
		wizard.completeStep(STEP);
		goto(WIZARD_STEPS[STEP + 1].path);
	}
</script>

<svelte:head><title>Attributes — Guild Book</title></svelte:head>

<h1>Assign your attributes</h1>

{#if !pathSuit}
	<p class="warn">Choose a <a href={WIZARD_STEPS[2].path}>Path</a> first — it sets your highest attribute.</p>
{:else}
	<p class="lede">
		Your {path?.name} locks <strong>{SUIT_LABELS[pathSuit]}</strong> at <strong>{highest}</strong>. Give
		{restValues.join(', ')} to the other three suits.
	</p>

	<div class="rows">
		<div class="row locked">
			<span class="suit">{SUIT_LABELS[pathSuit]}</span>
			<span class="fixed">{highest}</span>
		</div>
		{#each otherSuits as suit (suit)}
			<div class="row">
				<label class="suit" for="attr-{suit}">{SUIT_LABELS[suit]}</label>
				<select id="attr-{suit}" bind:value={assignment[suit]}>
					<option value={null}>—</option>
					{#each restValues as v}
						<option value={v}>{v}</option>
					{/each}
				</select>
			</div>
		{/each}
	</div>

	{#if usedValues.length === restValues.length && !isValid}
		<p class="warn">Each of {restValues.join(', ')} must be used exactly once.</p>
	{/if}
{/if}

<WizardNav
	backPath={WIZARD_STEPS[STEP - 1].path}
	onContinue={next}
	continueDisabled={!pathSuit || !isValid}
/>

<style>
	.lede {
		color: var(--ink-soft);
	}
	.warn {
		color: var(--accent);
	}
	.rows {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		margin: 1.5rem 0;
		max-width: 22rem;
	}
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.6rem 0.9rem;
		border: 1px solid color-mix(in oklab, var(--ink) 20%, transparent);
		border-radius: 4px;
	}
	.row.locked {
		border-color: var(--accent);
		background: color-mix(in oklab, var(--accent) 8%, var(--parchment));
	}
	.suit {
		font-family: var(--font-heading);
		font-size: 1.05rem;
	}
	.fixed {
		font-family: var(--font-display);
		font-size: 1.6rem;
		line-height: 1;
	}
	select {
		padding: 0.35rem 0.5rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 3px;
		background: var(--parchment);
		font: inherit;
	}
</style>
