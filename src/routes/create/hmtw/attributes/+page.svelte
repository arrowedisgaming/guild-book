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

	function valueUsedByOther(suit: SuitId, value: number): boolean {
		return otherSuits.some((candidate) => candidate !== suit && assignment[candidate] === value);
	}

	/** Select a free value, or click the current value again to release it. */
	function assignValue(suit: SuitId, value: number) {
		if (valueUsedByOther(suit, value)) return;
		assignment = { ...assignment, [suit]: assignment[suit] === value ? null : value };
	}

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

	<div class="assignment-board">
		<div class="locked">
			<span>
				<span class="eyebrow">Path attribute</span>
				<span class="suit">{SUIT_LABELS[pathSuit]}</span>
			</span>
			<strong class="locked-value">{highest}</strong>
		</div>

		<div class="matrix">
			<div class="matrix-head" aria-hidden="true">
				<span></span>
				{#each restValues as value (value)}<span>{value}</span>{/each}
			</div>
			{#each otherSuits as suit (suit)}
				<div class="attribute-row">
					<span class="suit">{SUIT_LABELS[suit]}</span>
					<div class="value-choices" role="radiogroup" aria-label="{SUIT_LABELS[suit]} value">
						{#each restValues as value (value)}
							<button
								type="button"
								class="value"
								class:selected={assignment[suit] === value}
								role="radio"
								aria-checked={assignment[suit] === value}
								disabled={valueUsedByOther(suit, value)}
								onclick={() => assignValue(suit, value)}
							>
								{value}
							</button>
						{/each}
					</div>
				</div>
			{/each}
		</div>
	</div>
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
	.assignment-board {
		display: flex;
		flex-direction: column;
		gap: 0.65rem;
		margin: 1.25rem 0;
		max-width: 25rem;
	}
	.locked {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.55rem 0.75rem;
		border: 1px solid var(--accent);
		border-radius: 4px;
		background: color-mix(in oklab, var(--accent) 8%, var(--parchment));
	}
	.eyebrow {
		display: block;
		margin-bottom: 0.05rem;
		font-family: var(--font-subhead);
		font-size: 0.65rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--accent);
	}
	.suit {
		font-family: var(--font-heading);
		font-size: 1rem;
	}
	.matrix {
		padding: 0.25rem 0.4rem 0.4rem;
		border: 1px solid color-mix(in oklab, var(--ink) 18%, transparent);
		border-radius: 4px;
	}
	.matrix-head,
	.attribute-row {
		display: grid;
		grid-template-columns: minmax(7.5rem, 1fr) repeat(3, 2.5rem);
		align-items: center;
		column-gap: 0.35rem;
	}
	.matrix-head {
		padding: 0.1rem 0 0.25rem;
		font-family: var(--font-subhead);
		font-size: 0.7rem;
		color: var(--ink-soft);
		text-align: center;
	}
	.attribute-row {
		padding: 0.3rem 0;
		border-top: 1px solid color-mix(in oklab, var(--ink) 10%, transparent);
	}
	.value-choices {
		display: contents;
	}
	.value {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2.5rem;
		height: 2.25rem;
		padding: 0;
		border: 1px solid color-mix(in oklab, var(--ink) 22%, transparent);
		border-radius: 3px;
		background: var(--parchment);
		font-family: var(--font-heading);
		font-size: 1.05rem;
		line-height: 1;
		cursor: pointer;
	}
	.value:hover {
		border-color: color-mix(in oklab, var(--accent) 60%, transparent);
	}
	.value.selected {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--parchment);
	}
	.value:disabled {
		opacity: 0.32;
		cursor: not-allowed;
	}
	.value:disabled::after {
		content: '';
		position: absolute;
		left: 0.35rem;
		right: 0.35rem;
		top: 50%;
		height: 1px;
		background: currentColor;
		transform: rotate(-35deg);
		transform-origin: center;
	}
	.locked-value {
		font-family: var(--font-heading);
		font-size: 1.8rem;
		font-weight: 400;
		line-height: 1;
		color: var(--accent);
	}
</style>
