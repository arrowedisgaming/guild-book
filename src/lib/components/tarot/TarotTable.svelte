<script lang="ts">
	import { untrack } from 'svelte';
	import { createTarotTable, tarotAnimate } from '$lib/stores/tarot-deck';
	import { toDrawnCard } from '$lib/tarot/protocol';
	import TarotCard from './TarotCard.svelte';
	import type { TarotConfig } from '$lib/types/content-pack';

	let { config }: { config: TarotConfig } = $props();

	const table = untrack(() => createTarotTable(config));

	// Auto-clear the reshuffle cue shortly after it appears.
	$effect(() => {
		if ($table.reshuffled) {
			const t = setTimeout(() => table.clearReshuffleFlag(), 1800);
			return () => clearTimeout(t);
		}
	});
</script>

<div class="tarot-table">
	<div class="piles">
		<button
			type="button"
			class="deck"
			onclick={() => table.drawCards(1)}
			aria-label="Draw a card"
		>
			<TarotCard faceDown />
			<span class="count">{$table.drawPile.length}</span>
		</button>
		<div class="deck-labels">
			<span>Draw pile</span>
			<span class="discard-count">Discard: {$table.discard.length}</span>
		</div>
	</div>

	{#if $table.reshuffled}
		<p class="cue" role="status">↻ Deck reshuffled</p>
	{/if}

	<div class="actions">
		<button type="button" onclick={() => table.drawCards(1)}>Draw</button>
		<button type="button" onclick={() => table.discardHand()} disabled={$table.hand.length === 0}>
			Discard hand
		</button>
		<button type="button" onclick={() => table.reshuffleAll()}>Reshuffle all</button>
		<button type="button" class="ghost" onclick={() => table.reset()}>Reset</button>
		<label class="anim">
			<input type="checkbox" bind:checked={$tarotAnimate} /> Animate
		</label>
	</div>

	<div class="hand" class:animate={$tarotAnimate}>
		{#each $table.hand as card (card.id)}
			<div class="slot"><TarotCard card={toDrawnCard(card)} /></div>
		{/each}
		{#if $table.hand.length === 0}
			<p class="empty">Your hand is empty — draw a card.</p>
		{/if}
	</div>
</div>

<style>
	.piles {
		display: flex;
		align-items: center;
		gap: 1rem;
	}
	.deck {
		position: relative;
		border: none;
		background: none;
		padding: 0;
		cursor: pointer;
	}
	.deck .count {
		position: absolute;
		bottom: 0.4rem;
		left: 50%;
		transform: translateX(-50%);
		font-size: 0.8rem;
		color: color-mix(in oklab, var(--parchment) 85%, transparent);
		background: rgba(0, 0, 0, 0.35);
		padding: 0.05rem 0.4rem;
		border-radius: 999px;
	}
	.deck-labels {
		display: flex;
		flex-direction: column;
		font-family: var(--font-subhead);
		font-size: 0.85rem;
		color: var(--ink-soft);
	}
	.cue {
		margin: 0.75rem 0 0;
		color: var(--accent);
		font-family: var(--font-subhead);
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		margin: 1.25rem 0;
	}
	.actions button {
		padding: 0.45rem 0.9rem;
		border: 1px solid var(--accent);
		border-radius: 3px;
		background: var(--accent);
		color: var(--parchment);
		font-family: var(--font-subhead);
		cursor: pointer;
	}
	.actions button.ghost {
		background: transparent;
		color: var(--accent);
	}
	.actions button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.anim {
		margin-left: auto;
		font-size: 0.85rem;
		color: var(--ink-soft);
	}
	.hand {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
		min-height: 8.5rem;
		align-items: center;
	}
	.empty {
		color: var(--ink-soft);
	}
	.hand.animate .slot {
		animation: deal 0.28s ease-out;
	}
	@keyframes deal {
		from {
			opacity: 0;
			transform: translateY(-8px) rotate(-2deg);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.hand.animate .slot {
			animation: none;
		}
	}
</style>
