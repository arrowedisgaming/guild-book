<script lang="ts">
	import { goto } from '$app/navigation';
	import { wizard, WIZARD_STEPS } from '$lib/stores/wizard';
	import WizardNav from '$lib/components/wizard/WizardNav.svelte';
	import Prose from '$lib/components/ui/Prose.svelte';
	import { shortenedIntroduction } from '$lib/utils/text';
	import type { PageData } from './$types';

	const STEP = 1;
	let { data }: { data: PageData } = $props();

	let kithId = $state($wizard.character.kithId);
	let kinId = $state($wizard.character.kinId);

	let selectedKith = $derived(data.kiths.find((k) => k.id === kithId) ?? null);
	let selectedKin = $derived(selectedKith?.kins.find((k) => k.id === kinId) ?? null);

	let talentById = $derived(new Map(data.talents.map((t) => [t.id, t])));

	// The talents a kin grants: its signature (mastered at creation) and the
	// arête talent it can earn.
	let kinTalents = $derived.by(() => {
		if (!selectedKin) return [];
		const out: { kind: string; name: string; description: string }[] = [];
		const mastered = talentById.get(selectedKin.masteredTalentId);
		if (mastered) out.push({ kind: 'Kin talent', name: mastered.name, description: mastered.description });
		const arete = selectedKin.areteTalentId ? talentById.get(selectedKin.areteTalentId) : undefined;
		if (arete) out.push({ kind: 'Arête talent', name: arete.name, description: arete.description });
		return out;
	});

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

<div class="choices" role="radiogroup" aria-label="Kith">
	{#each data.kiths as kith (kith.id)}
		<button
			type="button"
			class="choice"
			role="radio"
			aria-checked={kithId === kith.id}
			class:sel={kithId === kith.id}
			onclick={() => pickKith(kith.id)}
		>
			{kith.name}
		</button>
	{/each}
</div>

	{#if selectedKith}
	<div class="blurb">
		<Prose text={shortenedIntroduction(selectedKith.description)} />
		<details class="full-lore">
			<summary>Read more {selectedKith.name} lore</summary>
			<Prose text={selectedKith.description} />
		</details>
	</div>

	<h2>Choose your kin</h2>
	<div class="choices" role="radiogroup" aria-label="Kin">
		{#each selectedKith.kins as kin (kin.id)}
			<button
				type="button"
				class="choice"
				role="radio"
				aria-checked={kinId === kin.id}
				class:sel={kinId === kin.id}
				onclick={() => (kinId = kin.id)}
			>
				{kin.name}
			</button>
		{/each}
	</div>

	{#if selectedKin}
		<div class="blurb">
			<Prose text={selectedKin.description} />
			<ul class="kin-talents">
				{#each kinTalents as t (t.name)}
					<li>
						<span class="tkind">{t.kind}</span>
						<span class="tname">{t.name}</span>
						<Prose class="tdesc" text={t.description} />
					</li>
				{/each}
			</ul>
		</div>
	{/if}
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
	.blurb {
		max-width: 42rem;
		margin-top: 0.9rem;
		font-size: 0.9rem;
		color: var(--ink-soft);
	}
	.full-lore {
		margin-top: 0.65rem;
	}
	.full-lore summary {
		cursor: pointer;
		font-family: var(--font-subhead);
		color: var(--accent);
	}
	.full-lore :global(.prose) {
		margin-top: 0.65rem;
	}
	.kin-talents {
		list-style: none;
		padding: 0;
		margin: 0.9rem 0 0;
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
	}
	.kin-talents li {
		border-left: 2px solid color-mix(in oklab, var(--accent) 40%, transparent);
		padding-left: 0.75rem;
	}
	.tkind {
		display: block;
		font-family: var(--font-subhead);
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: color-mix(in oklab, var(--accent) 75%, var(--ink));
	}
	.tname {
		font-family: var(--font-heading);
		font-size: 1rem;
		color: var(--ink);
	}
	.kin-talents :global(.tdesc) {
		margin-top: 0.15rem;
		font-size: 0.85rem;
	}
</style>
