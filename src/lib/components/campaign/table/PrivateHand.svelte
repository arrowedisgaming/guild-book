<script lang="ts">
	/**
	 * The viewer's own hand — GM's `gmHand` or a player's `privateHand` — the
	 * only place real card identities the viewer owns are ever rendered.
	 * Pinned to the bottom of the table column on desktop; a horizontal
	 * scroller on mobile (`layout="mobile"`). The "Draw a card" control only
	 * renders when `canDraw` (from the projection's own `legalCommands`) says
	 * so — never guessed from role alone.
	 */
	import { renderableCard } from '$lib/stores/campaign-session.svelte';
	import TarotCard from '$lib/components/tarot/TarotCard.svelte';
	import type { CardSlot } from '$lib/types/session';

	let {
		cards,
		heading,
		canDraw,
		onDraw,
		layout = 'desktop'
	}: {
		cards: CardSlot[];
		heading: string;
		canDraw: boolean;
		onDraw: () => void | Promise<void>;
		layout?: 'desktop' | 'mobile';
	} = $props();
</script>

<section class="private-hand {layout}" data-testid="private-hand" aria-label={heading}>
	<div class="head">
		<h2>{heading}</h2>
		{#if canDraw}
			<button type="button" onclick={onDraw}>Draw a card</button>
		{/if}
	</div>
	{#if cards.length === 0}
		<p class="empty">No cards in hand.</p>
	{:else}
		<div class="cards">
			{#each cards as slot, index (index)}
				{@const rendered = renderableCard(slot)}
				<div data-testid="hand-card">
					<TarotCard card={rendered.card} faceDown={rendered.faceDown} />
				</div>
			{/each}
		</div>
	{/if}
</section>

<style>
	.private-hand {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 1rem;
		border: 1px solid color-mix(in oklab, var(--ink) 18%, transparent);
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}
	h2 {
		margin: 0;
		font-size: 1rem;
	}
	.empty {
		margin: 0;
		color: var(--ink-soft);
		font-size: 0.85rem;
	}
	.cards {
		display: flex;
		gap: 0.5rem;
	}
	.private-hand.mobile .cards {
		flex-wrap: nowrap;
		overflow-x: auto;
		padding-bottom: 0.25rem;
	}
	button {
		border: 1px solid color-mix(in oklab, var(--accent) 55%, transparent);
		background: none;
		padding: 0.45rem 0.75rem;
		font-family: var(--font-subhead);
		cursor: pointer;
	}
</style>
