<script lang="ts">
	import type { DrawnCard } from '$lib/tarot/protocol';
	import type { SuitId } from '$lib/types/common';

	interface Props {
		card?: DrawnCard | null;
		faceDown?: boolean;
		size?: 'sm' | 'md';
	}
	let { card = null, faceDown = false, size = 'md' }: Props = $props();

	const suitGlyph: Record<SuitId, string> = {
		swords: '⚔',
		pentacles: '✦',
		cups: '❦',
		wands: '❋'
	};
</script>

{#if faceDown || !card}
	<div class="card back {size}" aria-label="Face-down card">
		<span class="mark">❦</span>
	</div>
{:else if card.kind === 'major'}
	<div class="card major {size}" aria-label={card.label} data-card-id={card.id}>
		<span class="mnum">{card.value}</span>
		<span class="mname">{card.label}</span>
	</div>
{:else}
	<div class="card minor suit-{card.suit} {size}" aria-label={card.label} data-card-id={card.id}>
		<span class="rank">{card.label.split(' of ')[0]}</span>
		<span class="glyph">{card.suit ? suitGlyph[card.suit] : ''}</span>
		<span class="suit">{card.suit}</span>
		<span class="value">{card.value}</span>
	</div>
{/if}

<style>
	.card {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.2rem;
		width: 5.5rem;
		height: 8.5rem;
		border: 1px solid var(--ink);
		border-radius: 8px;
		background: var(--parchment);
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
		text-align: center;
		user-select: none;
	}
	.card.sm {
		width: 3.6rem;
		height: 5.6rem;
	}
	.back {
		background: repeating-linear-gradient(
			45deg,
			color-mix(in oklab, var(--accent) 55%, #1a1a1a),
			color-mix(in oklab, var(--accent) 55%, #1a1a1a) 6px,
			color-mix(in oklab, var(--accent) 35%, #1a1a1a) 6px,
			color-mix(in oklab, var(--accent) 35%, #1a1a1a) 12px
		);
		color: color-mix(in oklab, var(--parchment) 80%, transparent);
	}
	.back .mark {
		font-size: 1.6rem;
		opacity: 0.7;
	}
	.rank {
		font-family: var(--font-display);
		font-size: 1.4rem;
		line-height: 1;
	}
	.glyph {
		font-size: 2rem;
		line-height: 1;
	}
	.suit {
		font-size: 0.7rem;
		text-transform: capitalize;
		color: var(--ink-soft);
	}
	.value {
		position: absolute;
		top: 0.3rem;
		right: 0.4rem;
		font-size: 0.75rem;
		color: var(--ink-soft);
	}
	.suit-swords {
		color: #2f4a63;
	}
	.suit-pentacles {
		color: #8a6d1f;
	}
	.suit-cups {
		color: #7a2230;
	}
	.suit-wands {
		color: #3d6141;
	}
	.major {
		background: color-mix(in oklab, var(--accent) 10%, var(--parchment));
	}
	.mnum {
		font-family: var(--font-display);
		font-size: 1.6rem;
	}
	.mname {
		font-family: var(--font-heading);
		font-size: 0.85rem;
		padding: 0 0.3rem;
	}
	.sm .rank {
		font-size: 1rem;
	}
	.sm .glyph {
		font-size: 1.3rem;
	}
	.sm .mname {
		font-size: 0.65rem;
	}
</style>
