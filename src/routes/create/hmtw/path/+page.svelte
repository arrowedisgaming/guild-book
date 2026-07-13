<script lang="ts">
	import { goto } from '$app/navigation';
	import { wizard, WIZARD_STEPS } from '$lib/stores/wizard';
	import { createBlankCharacter } from '$lib/types/character';
	import WizardNav from '$lib/components/wizard/WizardNav.svelte';
	import Prose from '$lib/components/ui/Prose.svelte';
	import { paragraphizeSentences } from '$lib/utils/text';
	import type { PageData } from './$types';

	const STEP = 2;
	let { data }: { data: PageData } = $props();

	let pathId = $state($wizard.character.pathId);
	let selectedPath = $derived(data.paths.find((path) => path.id === pathId) ?? null);

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

<div class="choices" role="radiogroup" aria-label="Path">
	{#each data.paths as path (path.id)}
		<button
			type="button"
			class="choice"
			class:sel={pathId === path.id}
			role="radio"
			aria-checked={pathId === path.id}
			onclick={() => (pathId = path.id)}
		>
			{path.name}
		</button>
	{/each}
</div>

{#if selectedPath}
	<section class="details" aria-live="polite">
		<p class="suit">Highest attribute: {selectedPath.suit}</p>
		<Prose text={paragraphizeSentences(selectedPath.description, 3)} />
	</section>
{/if}

<WizardNav backPath={WIZARD_STEPS[STEP - 1].path} onContinue={next} continueDisabled={!pathId} />

<style>
	.lede {
		color: var(--ink-soft);
		margin-top: -0.25rem;
	}
	.choices {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 1rem;
	}
	.choice {
		font-family: var(--font-heading);
		font-size: 1.05rem;
		padding: 0.5rem 1.1rem;
		border: 1px solid color-mix(in oklab, var(--ink) 20%, transparent);
		border-radius: 4px;
		background: var(--parchment);
		cursor: pointer;
	}
	.choice:hover {
		border-color: color-mix(in oklab, var(--accent) 55%, transparent);
	}
	.choice.sel {
		border-color: var(--accent);
		background: color-mix(in oklab, var(--accent) 12%, var(--parchment));
		color: var(--accent);
	}
	.suit {
		margin: 0 0 0.65rem;
		font-size: 0.8rem;
		text-transform: capitalize;
		color: var(--accent);
		font-family: var(--font-subhead);
	}
	.details {
		max-width: 44rem;
		margin-top: 1rem;
		padding: 1rem 1.1rem;
		border-left: 2px solid color-mix(in oklab, var(--accent) 45%, transparent);
		background: color-mix(in oklab, var(--accent) 4%, var(--parchment));
		font-size: 0.9rem;
		color: var(--ink-soft);
	}
</style>
