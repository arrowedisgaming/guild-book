<script lang="ts">
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { wizard, WIZARD_STEPS } from '$lib/stores/wizard';
	import { resolveKin, kinGrants } from '$lib/engine/kindred';
	import { resolvePath, buildStartingTalents } from '$lib/engine/calling';
	import WizardNav from '$lib/components/wizard/WizardNav.svelte';
	import Prose from '$lib/components/ui/Prose.svelte';
	import type { PageData } from './$types';

	const STEP = 4;
	let { data }: { data: PageData } = $props();

	const resolved = $derived(
		resolveKin(data.kiths, $wizard.character.kithId, $wizard.character.kinId)
	);
	const path = $derived(resolvePath(data.paths, $wizard.character.pathId));
	const talentName = (id: string) => data.talents.find((t) => t.id === id)?.name ?? id;
	const talentDesc = (id: string) => data.talents.find((t) => t.id === id)?.description ?? '';

	const kinTalentId = $derived(resolved ? kinGrants(resolved).masteredTalentId : null);

	// Seed the mastered path talent once from any prior choice, else the first.
	let masteredPathTalentId = $state<string | null>(
		untrack(() => {
			const prior = $wizard.character.talents.find(
				(t) => t.source === 'path' && t.state === 'mastered'
			)?.talentId;
			return prior ?? path?.talentIds[0] ?? null;
		})
	);
	let selectedPathTalent = $derived(
		path?.talentIds.includes(masteredPathTalentId ?? '')
			? data.talents.find((talent) => talent.id === masteredPathTalentId) ?? null
			: null
	);

	function next() {
		if (!resolved || !path) return;
		const talents = buildStartingTalents({
			kin: resolved.kin,
			path,
			masteredPathTalentId,
			at: new Date().toISOString()
		});
		wizard.updateCharacter((c) => ({
			...c,
			talents,
			arete: { ...c.arete, triggersMet: [false, false, false] }
		}));
		wizard.completeStep(STEP);
		goto(WIZARD_STEPS[STEP + 1].path);
	}
</script>

<svelte:head><title>Talents — Guild Book</title></svelte:head>

<h1>Talents</h1>

{#if !resolved || !path}
	<p class="warn">
		Choose your <a href={WIZARD_STEPS[1].path}>kith &amp; kin</a> and
		<a href={WIZARD_STEPS[2].path}>path</a> first.
	</p>
{:else}
	<p class="lede">
		Your kin grants a mastered talent. Your path grants {path.talentIds.length}; master one now — the
		rest stay in training.
	</p>

	{#if kinTalentId}
		<section>
			<h2>Kin talent (mastered)</h2>
			<div class="talent granted">
				<div class="trow">
					<span class="tname">{talentName(kinTalentId)}</span>
					<span class="state">mastered</span>
				</div>
				<Prose class="tdesc" text={talentDesc(kinTalentId)} />
			</div>
		</section>
	{/if}

	<section>
		<h2>Path talents — master one</h2>
		<div class="choices" role="radiogroup" aria-label="Path talent to master">
			{#each path.talentIds as id (id)}
				<button
					type="button"
					class="choice"
					class:sel={masteredPathTalentId === id}
					role="radio"
					aria-checked={masteredPathTalentId === id}
					onclick={() => (masteredPathTalentId = id)}
				>
					{talentName(id)}
				</button>
			{/each}
		</div>
		{#if selectedPathTalent}
			<div class="talent selected-detail" aria-live="polite">
				<div class="trow">
					<span class="tname">{selectedPathTalent.name}</span>
					<span class="state">mastered</span>
				</div>
				<Prose class="tdesc" text={selectedPathTalent.description} />
			</div>
		{/if}
	</section>
{/if}

<WizardNav
	backPath={WIZARD_STEPS[STEP - 1].path}
	onContinue={next}
	continueDisabled={!resolved || !path || !masteredPathTalentId}
/>

<style>
	.lede {
		color: var(--ink-soft);
	}
	.warn {
		color: var(--accent);
	}
	h2 {
		font-size: 1rem;
		margin: 1.25rem 0 0.5rem;
	}
	.choices {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.choice {
		font-family: var(--font-heading);
		font-size: 0.95rem;
		padding: 0.45rem 0.85rem;
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
	.talent {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 0.7rem 0.9rem;
		border: 1px solid color-mix(in oklab, var(--ink) 20%, transparent);
		border-radius: 4px;
		cursor: pointer;
	}
	.talent.granted {
		border-color: var(--accent);
		background: color-mix(in oklab, var(--accent) 8%, var(--parchment));
		cursor: default;
	}
	.selected-detail {
		max-width: 44rem;
		margin-top: 0.75rem;
		border-left: 2px solid color-mix(in oklab, var(--accent) 45%, transparent);
		background: color-mix(in oklab, var(--accent) 4%, var(--parchment));
	}
	.trow {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}
	.tname {
		font-family: var(--font-heading);
		font-size: 1.05rem;
	}
	.talent :global(.tdesc) {
		margin: 0;
		font-size: 0.83rem;
		color: var(--ink-soft);
	}
	.state {
		margin-left: auto;
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--ink-soft);
		white-space: nowrap;
	}
</style>
