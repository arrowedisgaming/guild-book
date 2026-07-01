<script lang="ts">
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { wizard, WIZARD_STEPS } from '$lib/stores/wizard';
	import WizardNav from '$lib/components/wizard/WizardNav.svelte';
	import type { PageData } from './$types';

	const STEP = 5;
	let { data }: { data: PageData } = $props();

	const motifCount = $derived(data.contentPack.creation.motifCount);

	let quest = $state($wizard.character.quest);
	let motifs = $state<string[]>(
		untrack(() =>
			Array.from(
				{ length: data.contentPack.creation.motifCount },
				(_, i) => $wizard.character.motifs[i] ?? ''
			)
		)
	);

	function persist() {
		wizard.updateCharacter((c) => ({
			...c,
			quest,
			motifs: motifs.map((m) => m.trim()).filter(Boolean)
		}));
	}

	function next() {
		persist();
		wizard.completeStep(STEP);
		goto(WIZARD_STEPS[STEP + 1].path);
	}
</script>

<svelte:head><title>Quest &amp; Motifs — Guild Book</title></svelte:head>

<h1>Quest &amp; Motifs</h1>
<p class="lede">Your quest is why you delve. Your motifs are the lives you lived before.</p>

<label class="field">
	<span>Quest</span>
	<textarea bind:value={quest} oninput={persist} rows="2" placeholder="e.g. Find the Grail of Mythrys to cure my petrified brother."></textarea>
</label>

<h2>Motifs <small>(up to {motifCount}: a descriptor + a profession)</small></h2>
<div class="motifs">
	{#each motifs as _, i (i)}
		<input
			type="text"
			bind:value={motifs[i]}
			oninput={persist}
			list="motif-suggestions"
			placeholder="e.g. Wealthy Artificer"
		/>
	{/each}
</div>

<datalist id="motif-suggestions">
	{#each data.motifs.descriptors as d}
		{#each data.motifs.professions as p}
			<option value="{d} {p}"></option>
		{/each}
	{/each}
</datalist>

<WizardNav backPath={WIZARD_STEPS[STEP - 1].path} onContinue={next} />

<style>
	.lede {
		color: var(--ink-soft);
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		margin: 1.25rem 0;
	}
	.field span {
		font-family: var(--font-subhead);
	}
	h2 {
		font-size: 1rem;
	}
	h2 small {
		font-weight: normal;
		color: var(--ink-soft);
	}
	.motifs {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		max-width: 26rem;
		margin-top: 0.5rem;
	}
	textarea,
	input {
		padding: 0.55rem 0.7rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 3px;
		background: var(--parchment);
		font: inherit;
	}
</style>
