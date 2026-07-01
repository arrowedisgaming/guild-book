<script lang="ts">
	import { goto } from '$app/navigation';
	import { wizard, WIZARD_STEPS } from '$lib/stores/wizard';
	import WizardNav from '$lib/components/wizard/WizardNav.svelte';
	import type { PageData } from './$types';

	const STEP = 1;
	let { data }: { data: PageData } = $props();

	let kithId = $state($wizard.character.kithId);
	let kinId = $state($wizard.character.kinId);

	let selectedKith = $derived(data.kiths.find((k) => k.id === kithId) ?? null);

	function pickKith(id: string) {
		if (kithId !== id) {
			kithId = id;
			kinId = null; // reset kin when kith changes
		}
	}

	function persist() {
		wizard.updateCharacter((c) => ({ ...c, kithId, kinId }));
	}

	function next() {
		persist();
		wizard.completeStep(STEP);
		goto(WIZARD_STEPS[STEP + 1].path);
	}
</script>

<svelte:head><title>Kith &amp; Kin — Guild Book</title></svelte:head>

<h1>Kith &amp; Kin</h1>
<p class="lede">Your kith is your people; your kin, your clan. Your kin grants a mastered talent.</p>

<div class="grid">
	{#each data.kiths as kith (kith.id)}
		<button type="button" class="card" class:sel={kithId === kith.id} onclick={() => pickKith(kith.id)}>
			<span class="name">{kith.name}</span>
			<span class="desc">{kith.description}</span>
		</button>
	{/each}
</div>

{#if selectedKith}
	<h2>Choose your kin</h2>
	<div class="grid">
		{#each selectedKith.kins as kin (kin.id)}
			<button type="button" class="card" class:sel={kinId === kin.id} onclick={() => (kinId = kin.id)}>
				<span class="name">{kin.name}</span>
				<span class="desc">{kin.description}</span>
			</button>
		{/each}
	</div>
{/if}

<WizardNav backPath={WIZARD_STEPS[STEP - 1].path} onContinue={next} continueDisabled={!kithId || !kinId} />

<style>
	.lede {
		color: var(--ink-soft);
		margin-top: -0.25rem;
	}
	h2 {
		margin-top: 1.75rem;
		font-size: 1.1rem;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
		gap: 0.75rem;
		margin-top: 1rem;
	}
	.card {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		text-align: left;
		padding: 0.85rem;
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
		font-size: 1.05rem;
	}
	.desc {
		font-size: 0.85rem;
		color: var(--ink-soft);
	}
</style>
