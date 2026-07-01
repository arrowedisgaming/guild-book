<script lang="ts">
	import { goto } from '$app/navigation';
	import { wizard, WIZARD_STEPS } from '$lib/stores/wizard';
	import { createBlankCharacter } from '$lib/types/character';
	import WizardNav from '$lib/components/wizard/WizardNav.svelte';
	import type { PageData } from './$types';

	const STEP = 2;
	let { data }: { data: PageData } = $props();

	let pathId = $state($wizard.character.pathId);

	function next() {
		wizard.updateCharacter((c) => ({
			...c,
			pathId,
			// Changing the path changes which suit is locked to 4, so any prior
			// attribute assignment is cleared and re-done on the next step.
			attributes: createBlankCharacter().attributes
		}));
		wizard.completeStep(STEP);
		goto(WIZARD_STEPS[STEP + 1].path);
	}
</script>

<svelte:head><title>Path — Guild Book</title></svelte:head>

<h1>Choose your Path</h1>
<p class="lede">Your path is your calling. It sets your highest attribute (a 4) to its suit.</p>

<div class="grid">
	{#each data.paths as path (path.id)}
		<button type="button" class="card" class:sel={pathId === path.id} onclick={() => (pathId = path.id)}>
			<span class="name">{path.name}</span>
			<span class="suit">Highest attribute: {path.suit}</span>
			<span class="desc">{path.description}</span>
		</button>
	{/each}
</div>

<WizardNav backPath={WIZARD_STEPS[STEP - 1].path} onContinue={next} continueDisabled={!pathId} />

<style>
	.lede {
		color: var(--ink-soft);
		margin-top: -0.25rem;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
		gap: 0.75rem;
		margin-top: 1.25rem;
	}
	.card {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		text-align: left;
		padding: 0.95rem;
		border: 1px solid color-mix(in oklab, var(--ink) 20%, transparent);
		border-radius: 4px;
		background: var(--parchment);
		cursor: pointer;
	}
	.card:hover {
		border-color: color-mix(in oklab, var(--accent) 55%, transparent);
	}
	.card.sel {
		border-color: var(--accent);
		background: color-mix(in oklab, var(--accent) 8%, var(--parchment));
	}
	.name {
		font-family: var(--font-heading);
		font-size: 1.1rem;
	}
	.suit {
		font-size: 0.8rem;
		text-transform: capitalize;
		color: var(--accent);
		font-family: var(--font-subhead);
	}
	.desc {
		font-size: 0.85rem;
		color: var(--ink-soft);
	}
</style>
