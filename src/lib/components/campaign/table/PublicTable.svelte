<script lang="ts">
	/**
	 * The shared table: public zones (initiative/played/revealed/inspiration),
	 * every private face-down/prepared zone's public card-back projection, and
	 * every *other* participant's hand as an opaque back + count
	 * (`otherHands`, precomputed by the caller from the public projection's
	 * `playerHandCounts` minus the viewer's own entry — a GM excludes none).
	 * Never renders a card object for anything hidden; `renderableCard`
	 * enforces that at the mapping boundary.
	 */
	import { renderableCard } from '$lib/stores/campaign-session.svelte';
	import TarotCard from '$lib/components/tarot/TarotCard.svelte';
	import type { SessionPublicProjection } from '$lib/types/session';

	let {
		publicProjection,
		otherHands
	}: {
		publicProjection: SessionPublicProjection;
		otherHands: { id: string; count: number }[];
	} = $props();

	const zoneLabels: Record<string, string> = {
		initiative: 'Initiative',
		played: 'Played',
		revealed: 'Revealed',
		inspiration: 'Inspiration'
	};

	function backs(count: number): number[] {
		return Array.from({ length: count }, (_value, index) => index);
	}
</script>

<section class="public-table" data-testid="public-table" aria-label="Shared table">
	<div class="zones">
		{#each publicProjection.publicZones as zone (zone.id)}
			<div class="zone" aria-label={zoneLabels[zone.kind] ?? zone.kind}>
				<h3>{zoneLabels[zone.kind] ?? zone.kind}</h3>
				{#if zone.cards.length === 0}
					<p class="empty">Empty</p>
				{:else}
					<div class="cards">
						{#each zone.cards as slot, index (index)}
							{@const rendered = renderableCard(slot)}
							<TarotCard card={rendered.card} faceDown={rendered.faceDown} size="sm" />
						{/each}
					</div>
				{/if}
			</div>
		{/each}
	</div>

	{#if publicProjection.privateZoneCardBacks.length > 0}
		<div class="zone" aria-label="Private effects">
			<h3>Private effects</h3>
			{#each publicProjection.privateZoneCardBacks as zone (zone.id)}
				<div class="owner-backs">
					<span>{zone.kind === 'player-facedown' ? 'Face-down' : 'Prepared'} ({zone.cards.length})</span>
					<div class="cards">
						{#each backs(zone.cards.length) as index (index)}
							<TarotCard faceDown size="sm" />
						{/each}
					</div>
				</div>
			{/each}
		</div>
	{/if}

	<div class="zone" aria-label="Other player hands">
		<h3>Hands</h3>
		{#if otherHands.length === 0}
			<p class="empty">No other hands.</p>
		{/if}
		{#each otherHands as hand (hand.id)}
			<div class="owner-backs" data-testid="other-hand-back">
				<span>{hand.count} card{hand.count === 1 ? '' : 's'}</span>
				<div class="cards">
					{#each backs(hand.count) as index (index)}
						<TarotCard faceDown size="sm" />
					{/each}
				</div>
			</div>
		{/each}
	</div>
</section>

<style>
	.public-table {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		padding: 1rem;
		border: 1px solid color-mix(in oklab, var(--ink) 18%, transparent);
	}
	.zones {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
		gap: 1rem;
	}
	h3 {
		margin: 0 0 0.5rem;
		font-size: 0.9rem;
	}
	.empty {
		margin: 0;
		color: var(--ink-soft);
		font-size: 0.85rem;
	}
	.cards {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}
	.owner-backs {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		margin-bottom: 0.5rem;
	}
	.owner-backs span {
		font-size: 0.8rem;
		color: var(--ink-soft);
	}
</style>
