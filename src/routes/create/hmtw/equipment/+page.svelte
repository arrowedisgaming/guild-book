<script lang="ts">
	import { goto } from '$app/navigation';
	import { wizard, WIZARD_STEPS } from '$lib/stores/wizard';
	import { ITEM_TIERS, type ItemTier } from '$lib/types/common';
	import WizardNav from '$lib/components/wizard/WizardNav.svelte';
	import type { PageData } from './$types';

	const STEP = 6;
	let { data }: { data: PageData } = $props();

	const allowance = $derived(data.contentPack.creation.marketAllowance);
	const caps = $derived<Record<ItemTier, number | null>>({
		luxurious: allowance.luxurious,
		common: allowance.common,
		impoverished: allowance.impoverished
	});
	const tierLabels: Record<ItemTier, string> = {
		luxurious: 'Luxurious',
		common: 'Common',
		impoverished: 'Impoverished'
	};

	let selected = $state<Set<string>>(
		new Set($wizard.character.equipment.map((e) => e.itemId).filter((x): x is string => !!x))
	);

	const itemsByTier = (tier: ItemTier) => data.items.filter((i) => i.tier === tier);
	function countInTier(tier: ItemTier): number {
		return data.items.filter((i) => i.tier === tier && selected.has(i.id)).length;
	}
	function atCap(tier: ItemTier, itemId: string): boolean {
		const cap = caps[tier];
		if (cap === null) return false;
		return !selected.has(itemId) && countInTier(tier) >= cap;
	}
	function toggle(itemId: string) {
		const next = new Set(selected);
		if (next.has(itemId)) next.delete(itemId);
		else next.add(itemId);
		selected = next;
	}

	function next() {
		const equipment = data.items
			.filter((i) => selected.has(i.id))
			.map((i) => ({ itemId: i.id, customName: null, tier: i.tier, packSpace: i.packSpace ?? 1 }));
		wizard.updateCharacter((c) => ({ ...c, equipment }));
		wizard.completeStep(STEP);
		goto(WIZARD_STEPS[STEP + 1].path);
	}
</script>

<svelte:head><title>Gear — Guild Book</title></svelte:head>

<h1>The Omphalic Market</h1>
<p class="lede">
	Outfit your adventurer: {allowance.luxurious} luxurious, {allowance.common} common, and as many
	impoverished items as you like.
</p>

{#each ITEM_TIERS as tier (tier)}
	<section>
		<h2>
			{tierLabels[tier]}
			<span class="count">
				{countInTier(tier)}{caps[tier] !== null ? ` / ${caps[tier]}` : ''}
			</span>
		</h2>
		<div class="grid">
			{#each itemsByTier(tier) as item (item.id)}
				<label class="item" class:sel={selected.has(item.id)} class:disabled={atCap(tier, item.id)}>
					<input
						type="checkbox"
						checked={selected.has(item.id)}
						disabled={atCap(tier, item.id)}
						onchange={() => toggle(item.id)}
					/>
					<span class="iname">{item.name}</span>
					<span class="idesc">{item.description}</span>
				</label>
			{/each}
		</div>
	</section>
{/each}

<WizardNav backPath={WIZARD_STEPS[STEP - 1].path} onContinue={next} />

<style>
	.lede {
		color: var(--ink-soft);
	}
	h2 {
		display: flex;
		align-items: baseline;
		gap: 0.6rem;
		font-size: 1.05rem;
		margin: 1.5rem 0 0.6rem;
	}
	.count {
		font-size: 0.8rem;
		color: var(--ink-soft);
		font-family: var(--font-subhead);
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
		gap: 0.5rem;
	}
	.item {
		display: grid;
		grid-template-columns: auto 1fr;
		grid-template-areas: 'chk name' 'chk desc';
		gap: 0.1rem 0.5rem;
		align-items: center;
		padding: 0.55rem 0.7rem;
		border: 1px solid color-mix(in oklab, var(--ink) 18%, transparent);
		border-radius: 4px;
		cursor: pointer;
	}
	.item.sel {
		border-color: var(--accent);
		background: color-mix(in oklab, var(--accent) 7%, var(--parchment));
	}
	.item.disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.item input {
		grid-area: chk;
	}
	.iname {
		grid-area: name;
		font-family: var(--font-heading);
		font-size: 0.95rem;
	}
	.idesc {
		grid-area: desc;
		font-size: 0.78rem;
		color: var(--ink-soft);
	}
</style>
