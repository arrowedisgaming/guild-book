<script lang="ts">
	/**
	 * The viewer's own hand — GM's `gmHand` or a player's `privateHand` — the
	 * only place real card identities the viewer owns are ever rendered.
	 * Pinned to the bottom of the table column on desktop; a horizontal
	 * scroller on mobile (`layout="mobile"`). The "Draw a card" control only
	 * renders when `canDraw` (from the projection's own `legalCommands`) says
	 * so — never guessed from role alone. Per-card Play/Play-face-down/
	 * Discard/Transfer controls are gated the same way (`canPlay`/
	 * `canPlaceFacedown`/`canDiscard`/`transferTargets`, all computed by the
	 * caller — `TableShell` — from `legalCommands` and the public projection,
	 * never guessed here).
	 */
	import { renderableCard } from '$lib/stores/campaign-session.svelte';
	import TarotCard from '$lib/components/tarot/TarotCard.svelte';
	import type { CardSlot } from '$lib/types/session';

	interface TransferTarget {
		zoneId: string;
		label: string;
	}

	let {
		cards,
		heading,
		canDraw,
		onDraw,
		layout = 'desktop',
		canPlay = false,
		canPlaceFacedown = false,
		canDiscard = false,
		transferTargets = [],
		onPlay,
		onPlaceFacedown,
		onDiscard,
		onTransfer
	}: {
		cards: CardSlot[];
		heading: string;
		canDraw: boolean;
		onDraw: () => void | Promise<void>;
		layout?: 'desktop' | 'mobile';
		canPlay?: boolean;
		canPlaceFacedown?: boolean;
		canDiscard?: boolean;
		transferTargets?: TransferTarget[];
		onPlay?: (cardId: string) => void | Promise<void>;
		onPlaceFacedown?: (cardId: string) => void | Promise<void>;
		onDiscard?: (cardId: string) => void | Promise<void>;
		onTransfer?: (cardId: string, destinationZoneId: string) => void | Promise<void>;
	} = $props();

	const canTransfer = $derived(transferTargets.length > 0);

	/** Keyed by card id, not index — a card's position in `cards` can shift
	 * between renders (a play/discard elsewhere in the hand), but its chosen
	 * transfer target shouldn't. */
	let selectedTransferTarget = $state<Record<string, string>>({});

	function transferTargetFor(cardId: string): string {
		return selectedTransferTarget[cardId] ?? transferTargets[0]?.zoneId ?? '';
	}
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
				{@const cardId = slot.hidden ? undefined : slot.id}
				<div data-testid="hand-card">
					<TarotCard card={rendered.card} faceDown={rendered.faceDown} />
					{#if cardId && (canPlay || canPlaceFacedown || canDiscard || canTransfer)}
						<div class="card-actions">
							{#if canPlay}
								<button type="button" onclick={() => onPlay?.(cardId)}>Play</button>
							{/if}
							{#if canPlaceFacedown}
								<button type="button" onclick={() => onPlaceFacedown?.(cardId)}>Play face down</button>
							{/if}
							{#if canDiscard}
								<button type="button" onclick={() => onDiscard?.(cardId)}>Discard</button>
							{/if}
							{#if canTransfer}
								<div class="transfer">
									{#if transferTargets.length > 1}
										<select
											aria-label="Transfer destination"
											value={transferTargetFor(cardId)}
											onchange={(event) => {
												selectedTransferTarget[cardId] = event.currentTarget.value;
											}}
										>
											{#each transferTargets as target (target.zoneId)}
												<option value={target.zoneId}>{target.label}</option>
											{/each}
										</select>
									{/if}
									<button type="button" onclick={() => onTransfer?.(cardId, transferTargetFor(cardId))}>
										Transfer{transferTargets.length === 1 ? ` to ${transferTargets[0].label}` : ''}
									</button>
								</div>
							{/if}
						</div>
					{/if}
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
		flex-wrap: nowrap;
		align-items: flex-start;
		gap: 0.5rem;
		/* Bug fix: an unbounded flex row lets card count grow past the
		 * section's border on both desktop and mobile — scroll within the
		 * hand region instead of overflowing the page (consistent across
		 * `layout="desktop"`/`layout="mobile"`, not just the mobile branch). */
		overflow-x: auto;
		padding-bottom: 0.25rem;
	}
	.cards > div {
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	.card-actions {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		width: 5.5rem;
	}
	.card-actions button {
		padding: 0.25rem 0.4rem;
		font-size: 0.7rem;
	}
	.transfer {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}
	.transfer select {
		font-size: 0.7rem;
		padding: 0.15rem;
	}
	button {
		border: 1px solid color-mix(in oklab, var(--accent) 55%, transparent);
		background: none;
		padding: 0.45rem 0.75rem;
		font-family: var(--font-subhead);
		cursor: pointer;
	}
</style>
