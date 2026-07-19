<script lang="ts">
	/**
	 * The viewer's own face-down zone (`facedown:<userId>`, seeded per campaign
	 * member — see `standardPrivateZonesForMember` in
	 * `src/lib/server/session/repository.ts`). Player-only: the GM has no
	 * facedown zone of their own, so `TableShell` only renders this for
	 * `role === 'player'`. Unlike `PublicTable`'s card-back projection of the
	 * *same* zone (which every other participant sees as opaque backs), the
	 * projection hands the owner their own real identities via
	 * `SessionPlayerProjection.privateFacedown` — so this renders faces, not
	 * backs, exactly like `PrivateHand` does for the hand. `canReveal` is
	 * computed by the caller from the projection's own `legalCommands`, never
	 * guessed here.
	 */
	import { renderableCard } from '$lib/stores/campaign-session.svelte';
	import TarotCard from '$lib/components/tarot/TarotCard.svelte';
	import type { CardSlot } from '$lib/types/session';

	let {
		cards,
		canReveal,
		onReveal,
		layout = 'desktop'
	}: {
		cards: CardSlot[];
		canReveal: boolean;
		onReveal: (cardId: string) => void | Promise<void>;
		layout?: 'desktop' | 'mobile';
	} = $props();
</script>

{#if cards.length > 0}
	<section class="private-facedown {layout}" data-testid="private-facedown" aria-label="Your face-down cards">
		<h2>Your face-down cards</h2>
		<div class="cards">
			{#each cards as slot, index (index)}
				{@const rendered = renderableCard(slot)}
				{@const cardId = slot.hidden ? undefined : slot.id}
				<div data-testid="facedown-card">
					<TarotCard card={rendered.card} faceDown={rendered.faceDown} />
					{#if canReveal && cardId}
						<button type="button" onclick={() => onReveal(cardId)}>Reveal</button>
					{/if}
				</div>
			{/each}
		</div>
	</section>
{/if}

<style>
	.private-facedown {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 1rem;
		border: 1px solid color-mix(in oklab, var(--ink) 18%, transparent);
	}
	h2 {
		margin: 0;
		font-size: 1rem;
	}
	.cards {
		display: flex;
		flex-wrap: nowrap;
		align-items: flex-start;
		gap: 0.5rem;
		/* Same overflow fix as `PrivateHand` — see that component's note. */
		overflow-x: auto;
		padding-bottom: 0.25rem;
	}
	.cards > div {
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	button {
		border: 1px solid color-mix(in oklab, var(--accent) 55%, transparent);
		background: none;
		padding: 0.25rem 0.4rem;
		font-family: var(--font-subhead);
		font-size: 0.7rem;
		cursor: pointer;
	}
</style>
