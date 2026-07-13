<script lang="ts">
	import { goto } from '$app/navigation';
	import { wizard, WIZARD_STEPS } from '$lib/stores/wizard';
	import { ITEM_TIERS, type ItemTier } from '$lib/types/common';
	import type { EquipmentEntry } from '$lib/types/character';
	import { autoPlace, loadSummary, indexItems } from '$lib/engine/encumbrance';
	import WizardNav from '$lib/components/wizard/WizardNav.svelte';
	import Prose from '$lib/components/ui/Prose.svelte';
	import type { PageData } from './$types';

	const STEP = 6;
	let { data }: { data: PageData } = $props();

	const allowance = $derived(data.contentPack.creation.marketAllowance);
	const caps = $derived(data.contentPack.encumbrance);
	const itemIndex = $derived(indexItems(data.items));

	const tierLabels: Record<ItemTier, string> = {
		luxurious: 'Luxurious',
		common: 'Common',
		impoverished: 'Impoverished'
	};

	// Items your chosen talents require are impoverished *for you* at creation:
	// they never count against the luxurious/common allowance.
	const requiredItemIds = $derived.by(() => {
		const chosen = new Set($wizard.character.talents.map((t) => t.talentId));
		const ids = new Set<string>();
		for (const talent of data.talents) {
			if (!chosen.has(talent.id)) continue;
			for (const id of talent.requiredItemIds ?? []) ids.add(id);
		}
		return ids;
	});

	let selected = $state<Set<string>>(
		new Set($wizard.character.equipment.map((e) => e.itemId).filter((x): x is string => !!x))
	);
	let detailItemId = $state<string | null>(
		$wizard.character.equipment.find((entry) => entry.itemId)?.itemId ?? null
	);
	let detailItem = $derived(data.items.find((item) => item.id === detailItemId) ?? null);

	function toEntries(ids: Set<string>): EquipmentEntry[] {
		return data.items
			.filter((i) => ids.has(i.id))
			.map((i) => ({
				itemId: i.id,
				customName: null,
				tier: i.tier,
				packSpace: i.slots ?? 1,
				location: 'pack' as const,
				quantity: 1,
				notchesTaken: 0
			}));
	}

	// Live auto-placement + slot meters, recomputed as the selection changes.
	const placed = $derived(autoPlace(toEntries(selected), itemIndex, caps));
	const load = $derived(loadSummary(placed, itemIndex, caps));

	const tierCaps = $derived<Record<ItemTier, number | null>>({
		luxurious: allowance.luxurious,
		common: allowance.common,
		impoverished: allowance.impoverished
	});

	const itemsByTier = (tier: ItemTier) =>
		data.items.filter((i) => i.tier === tier && !requiredItemIds.has(i.id));
	const requiredItems = $derived(data.items.filter((i) => requiredItemIds.has(i.id)));

	function countInTier(tier: ItemTier): number {
		return data.items.filter(
			(i) => i.tier === tier && selected.has(i.id) && !requiredItemIds.has(i.id)
		).length;
	}
	function atCap(tier: ItemTier, itemId: string): boolean {
		const cap = tierCaps[tier];
		if (cap === null || requiredItemIds.has(itemId)) return false;
		return !selected.has(itemId) && countInTier(tier) >= cap;
	}
	function toggle(itemId: string) {
		detailItemId = itemId;
		const next = new Set(selected);
		if (next.has(itemId)) next.delete(itemId);
		else next.add(itemId);
		selected = next;
	}
	function chooseItem(itemId: string, unavailable = false) {
		detailItemId = itemId;
		if (!unavailable) toggle(itemId);
	}

	function next() {
		wizard.updateCharacter((c) => ({ ...c, equipment: placed }));
		wizard.completeStep(STEP);
		goto(WIZARD_STEPS[STEP + 1].path);
	}
</script>

<svelte:head><title>Gear — Guild Book</title></svelte:head>

<h1>The Omphalic Market</h1>
<p class="lede">
	Outfit your adventurer: {allowance.luxurious} luxurious, {allowance.common} common, and as many
	impoverished items as you like — until your belt and backpack are full.
</p>

<div class="meters" aria-label="Carrying capacity">
	{#each [{ k: 'hands', label: 'Hands' }, { k: 'belt', label: 'Belt' }, { k: 'pack', label: 'Backpack' }] as m (m.k)}
		{@const loc = load[m.k as 'hands' | 'belt' | 'pack']}
		<div class="meter" class:over={loc.over}>
			<span class="mlabel">{m.label}</span>
			<div class="mbar">
				<div
					class="mfill"
					style="width: {Math.min(100, (loc.used / Math.max(1, loc.capacity)) * 100)}%"
				></div>
			</div>
			<span class="mcount">{loc.used}/{loc.capacity}</span>
		</div>
	{/each}
</div>
{#if load.hands.over || load.belt.over || load.pack.over}
	<p class="warn">You're carrying more than fits — drop something, or expect the GM's eyebrow.</p>
{/if}

{#if requiredItems.length}
	<section>
		<h2>Your talents need these <span class="count">impoverished for you</span></h2>
		<div class="grid">
			{#each requiredItems as item (item.id)}
				<button
					type="button"
					class="item req"
					class:sel={selected.has(item.id)}
					class:focused={detailItemId === item.id}
					role="checkbox"
					aria-checked={selected.has(item.id)}
					onclick={() => chooseItem(item.id)}
				>
					<span class="check" aria-hidden="true">{selected.has(item.id) ? '☑' : '☐'}</span>
					<span class="iname">{item.name}</span>
				</button>
			{/each}
		</div>
		{#if detailItem && requiredItemIds.has(detailItem.id)}
			<div class="item-detail" aria-live="polite">
				<h3>{detailItem.name}</h3>
				<p class="islots">{detailItem.slots ?? 1} slot{(detailItem.slots ?? 1) === 1 ? '' : 's'}{detailItem.carry === 'belt-only' ? ' · belt only' : ''}{detailItem.stack ? ` · ${detailItem.stack.per}/slot` : ''}</p>
				<Prose text={detailItem.description} />
			</div>
		{/if}
	</section>
{/if}

{#each ITEM_TIERS as tier (tier)}
	<section>
		<h2>
			{tierLabels[tier]}
			<span class="count">
				{countInTier(tier)}{tierCaps[tier] !== null ? ` / ${tierCaps[tier]}` : ''}
			</span>
		</h2>
		<div class="grid">
			{#each itemsByTier(tier) as item (item.id)}
				<button
					type="button"
					class="item"
					class:sel={selected.has(item.id)}
					class:focused={detailItemId === item.id}
					class:disabled={atCap(tier, item.id)}
					role="checkbox"
					aria-checked={selected.has(item.id)}
					aria-label={`${item.name}${atCap(tier, item.id) ? ', unavailable because the tier limit is reached; show details' : ''}`}
					onclick={() => chooseItem(item.id, atCap(tier, item.id))}
				>
					<span class="check" aria-hidden="true">{selected.has(item.id) ? '☑' : '☐'}</span>
					<span class="iname">{item.name}</span>
					<span class="islots">{item.slots ?? 1} slot{(item.slots ?? 1) === 1 ? '' : 's'}{item.carry === 'belt-only' ? ' · belt only' : ''}{item.stack ? ` · ${item.stack.per}/slot` : ''}</span>
				</button>
			{/each}
		</div>
		{#if detailItem && detailItem.tier === tier && !requiredItemIds.has(detailItem.id)}
			<div class="item-detail" aria-live="polite">
				<h3>{detailItem.name}</h3>
				<p class="islots">{detailItem.slots ?? 1} slot{(detailItem.slots ?? 1) === 1 ? '' : 's'}{detailItem.carry === 'belt-only' ? ' · belt only' : ''}{detailItem.stack ? ` · ${detailItem.stack.per}/slot` : ''}</p>
				<Prose text={detailItem.description} />
			</div>
		{/if}
	</section>
{/each}

<WizardNav backPath={WIZARD_STEPS[STEP - 1].path} onContinue={next} />

<style>
	.lede {
		color: var(--ink-soft);
	}
	.warn {
		color: var(--accent);
		font-size: 0.9rem;
	}
	.meters {
		display: flex;
		flex-wrap: wrap;
		gap: 1rem;
		margin: 1.25rem 0 0.5rem;
		position: sticky;
		top: 0;
		background: var(--parchment);
		padding: 0.5rem 0;
		z-index: 2;
	}
	.meter {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 12rem;
		flex: 1;
	}
	.mlabel {
		font-family: var(--font-subhead);
		font-size: 0.85rem;
		width: 5.2rem;
	}
	.mbar {
		flex: 1;
		height: 6px;
		border-radius: 999px;
		background: color-mix(in oklab, var(--ink) 12%, transparent);
	}
	.mfill {
		height: 6px;
		border-radius: 999px;
		background: var(--accent);
		transition: width 0.2s ease;
	}
	.meter.over .mfill {
		background: color-mix(in oklab, var(--accent) 70%, black);
	}
	.meter.over .mcount {
		color: var(--accent);
		font-weight: 700;
	}
	.mcount {
		font-size: 0.8rem;
		color: var(--ink-soft);
		min-width: 2.6rem;
		text-align: right;
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
		text-transform: none;
		letter-spacing: 0;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
		gap: 0.5rem;
	}
	.item {
		display: grid;
		grid-template-columns: auto 1fr;
		grid-template-areas: 'chk name' 'chk slots';
		gap: 0.1rem 0.5rem;
		align-items: start;
		padding: 0.55rem 0.7rem;
		border: 1px solid color-mix(in oklab, var(--ink) 18%, transparent);
		border-radius: 4px;
		cursor: pointer;
		text-align: left;
		background: var(--parchment);
		color: inherit;
		font: inherit;
	}
	.item.sel {
		border-color: var(--accent);
		background: color-mix(in oklab, var(--accent) 7%, var(--parchment));
	}
	.item.focused {
		box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--accent) 35%, transparent);
	}
	.item.req {
		border-style: dashed;
	}
	.item.disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.check {
		grid-area: chk;
		margin-top: 0.05rem;
		color: var(--accent);
	}
	.iname {
		grid-area: name;
		font-family: var(--font-heading);
		font-size: 0.95rem;
	}
	.islots {
		grid-area: slots;
		font-size: 0.7rem;
		color: var(--accent);
		font-family: var(--font-subhead);
	}
	.item-detail {
		max-width: 44rem;
		margin-top: 0.65rem;
		padding: 0.8rem 0.95rem;
		border-left: 2px solid color-mix(in oklab, var(--accent) 45%, transparent);
		background: color-mix(in oklab, var(--accent) 4%, var(--parchment));
		font-size: 0.85rem;
		color: var(--ink-soft);
	}
	.item-detail h3 {
		margin: 0 0 0.15rem;
		font-family: var(--font-heading);
		font-size: 1rem;
		color: var(--ink);
	}
	.item-detail .islots {
		margin: 0 0 0.45rem;
	}
</style>
