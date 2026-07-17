<script lang="ts">
	import { untrack } from 'svelte';
	import { createTarotTable } from '$lib/stores/tarot-deck';
	import { toDrawnCard } from '$lib/tarot/protocol';
	import { resolveTestOfFate } from '$lib/engine/tarot-resolution';
	import { isMinor } from '$lib/engine/tarot-deck';
	import { SUIT_IDS, SUIT_LABELS, type SuitId } from '$lib/types/common';
	import TarotCard from './TarotCard.svelte';
	import type { TarotConfig } from '$lib/types/content-pack';

	let { config, seed }: { config: TarotConfig; seed?: string | null } = $props();

	const table = untrack(() => createTarotTable(config, seed ?? undefined));

	let testedSuit = $state<SuitId | null>(null);
	let attribute = $state(2);
	let favor = $state(false);
	let disfavor = $state(false);
	let resolveSpentForFavor = $state(false);

	let hand = $derived($table.hand);

	/**
	 * Everything the test is declared against is frozen once a card is visible.
	 *
	 * Ch1 makes these pre-draw decisions — Resolve is spent "*prior* to a test of
	 * fate", and great success requires the tested suit on the *initial* draw. If
	 * the suit stayed editable you could see a Cups card, switch to Cups, and
	 * manufacture a great success; if favor stayed editable you could buy it
	 * retroactively. The engine cannot catch this: it only ever sees the final
	 * declaration, which is self-consistent.
	 */
	let locked = $derived(hand.length > 0);

	/** The engine takes the cards actually drawn; the UI never infers a push. */
	let result = $derived.by(() => {
		if (!testedSuit || hand.length === 0) return null;
		const [initial, pushCard] = hand;
		const toCard = (c: (typeof hand)[number]) => ({
			id: c.id,
			value: c.value,
			suit: isMinor(c) ? c.suit : undefined,
			origin: 'test-draw' as const
		});
		return resolveTestOfFate(config, {
			attribute,
			testedSuit,
			initialCard: toCard(initial),
			pushCard: pushCard ? toCard(pushCard) : null,
			favor,
			disfavor,
			resolveSpentForFavor
		});
	});

	$effect(() => {
		if (result?.foolDrawn && !$table.foolReshuffled) table.reshuffleForFool();
	});

	function drawInitial() {
		if (locked) return;
		table.discardHand();
		table.drawCards(1);
	}
	function push() {
		table.drawCards(1);
	}
	function reset() {
		table.discardHand();
	}
</script>

<div class="test">
	<div class="controls">
		<div class="group">
			<span class="lbl">Test</span>
			<div class="suits">
				{#each SUIT_IDS as s (s)}
					<button
						type="button"
						class:sel={testedSuit === s}
						disabled={locked}
						onclick={() => (testedSuit = s)}
					>
						{SUIT_LABELS[s]}
					</button>
				{/each}
			</div>
		</div>
		<div class="group">
			<label class="lbl" for="attr">Attribute</label>
			<select id="attr" bind:value={attribute} disabled={locked}>
				{#each [1, 2, 3, 4] as v}<option value={v}>{v}</option>{/each}
			</select>
		</div>
		<div class="group">
			<span class="lbl">Circumstance</span>
			<div class="checks">
				<label><input type="checkbox" bind:checked={favor} disabled={locked} /> Favor</label>
				<label><input type="checkbox" bind:checked={disfavor} disabled={locked} /> Disfavor</label>
				<label title="Spent before the draw to gain favor. Pushing fate is free.">
					<input type="checkbox" bind:checked={resolveSpentForFavor} disabled={locked} /> Spend 1 Resolve
					for favor
				</label>
			</div>
		</div>
	</div>

	<div class="actions">
		<button type="button" class="primary" disabled={!testedSuit || locked} onclick={drawInitial}>
			Draw &amp; test
		</button>
		<button
			type="button"
			disabled={!result?.canPush}
			title={result && !result.canPush && !result.pushed
				? 'You may only push a failed test'
				: undefined}
			onclick={push}
		>
			Push fate (+1 card)
		</button>
		<button type="button" class="ghost" disabled={hand.length === 0} onclick={reset}>Clear</button>
	</div>

	{#if hand.length}
		<div class="cards">
			{#each hand as c, i (c.id)}
				<div class="drawn">
					<TarotCard card={toDrawnCard(c)} size="sm" />
					<span class="tag">{i === 0 ? 'initial' : 'pushed'}</span>
				</div>
			{/each}
		</div>
	{/if}

	{#if result}
		<div
			class="result outcome-{result.outcome}"
			data-outcome={result.outcome}
			data-total={result.total}
			data-modifier={result.modifier}
		>
			<span class="total">{result.total}</span>
			<span class="label">{result.outcomeLabel}</span>
			<span class="detail">
				{attribute} ({testedSuit}) + {hand.map((c) => c.value).join(' + ')} card{hand.length > 1
					? 's'
					: ''}{#if result.modifier}
					{result.modifier > 0 ? '+' : '−'}{Math.abs(result.modifier)}
					{result.modifier > 0 ? 'favor' : 'disfavor'}{#if result.favorSources.includes('resolve')}
						&nbsp;(1 Resolve){/if}{/if}
			</span>
			{#if result.automaticGreatFailure}
				<span class="note">The Fool on a push is an automatic great failure.</span>
			{:else if result.favorSources.length === 2}
				<span class="note">Favor is not cumulative — one source is enough.</span>
			{/if}
			{#if result.foolDrawn && $table.foolReshuffled}
				<span class="note">The Fool was drawn. Both decks reshuffled.</span>
			{/if}
		</div>
	{:else if !testedSuit}
		<p class="hint">Pick a suit to test, set your attribute, then draw.</p>
	{/if}
</div>

<style>
	.controls {
		display: flex;
		flex-wrap: wrap;
		gap: 1.5rem;
		align-items: flex-start;
	}
	.group {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.lbl {
		font-family: var(--font-subhead);
		font-size: 0.85rem;
		color: var(--ink-soft);
	}
	.suits {
		display: flex;
		gap: 0.4rem;
	}
	.suits button {
		padding: 0.4rem 0.7rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 3px;
		background: var(--parchment);
		cursor: pointer;
		font-family: var(--font-subhead);
	}
	.suits button.sel {
		border-color: var(--accent);
		background: color-mix(in oklab, var(--accent) 10%, var(--parchment));
		color: var(--accent);
	}
	select {
		padding: 0.4rem 0.6rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 3px;
		background: var(--parchment);
		font: inherit;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin: 1.25rem 0;
	}
	.actions button {
		padding: 0.45rem 0.9rem;
		border: 1px solid var(--accent);
		border-radius: 3px;
		background: transparent;
		color: var(--accent);
		font-family: var(--font-subhead);
		cursor: pointer;
	}
	.actions button.primary {
		background: var(--accent);
		color: var(--parchment);
	}
	.actions button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.cards {
		display: flex;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	.drawn {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.25rem;
	}
	.tag {
		font-size: 0.65rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--ink-soft);
	}
	.result {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		margin-top: 1.25rem;
		padding: 0.9rem 1.1rem;
		border-radius: 6px;
		border: 1px solid color-mix(in oklab, var(--ink) 20%, transparent);
		max-width: 22rem;
	}
	.result .total {
		font-family: var(--font-display);
		font-size: 2rem;
		line-height: 1;
	}
	.result .label {
		font-family: var(--font-heading);
		font-size: 1.1rem;
	}
	.result .detail {
		font-size: 0.8rem;
		color: var(--ink-soft);
	}
	.result .note {
		font-size: 0.75rem;
		color: var(--ink-soft);
		font-style: italic;
		margin-top: 0.3rem;
	}
	.checks {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.checks label:has(input:disabled) {
		opacity: 0.6;
		cursor: not-allowed;
	}
	.checks label {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.85rem;
		cursor: pointer;
	}
	.outcome-great-success {
		background: color-mix(in oklab, #3d6141 16%, var(--parchment));
	}
	.outcome-success {
		background: color-mix(in oklab, #3d6141 8%, var(--parchment));
	}
	.outcome-failure {
		background: color-mix(in oklab, var(--accent) 8%, var(--parchment));
	}
	.outcome-great-failure {
		background: color-mix(in oklab, var(--accent) 18%, var(--parchment));
	}
	.hint {
		color: var(--ink-soft);
		margin-top: 1rem;
	}
</style>
