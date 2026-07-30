<script lang="ts">
	import type { DrawnCard } from '$lib/tarot/protocol';
	import type { SuitId } from '$lib/types/common';
	import { getTarotBackSources, getTarotFaceSources, hasTarotArt } from '$lib/tarot/art';
	import TarotCardImage from './TarotCardImage.svelte';
	import TarotCardDialog from './TarotCardDialog.svelte';

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

	let enlarged = $state(false);
	const imageSizes = $derived(size === 'sm' ? '58px' : '88px');
</script>

<!-- Issue #10 Task 4. Branch order is the privacy invariant: the face-down
     branch comes first and never touches `card`, so `getTarotFaceSources`
     (and the card id it would put in a URL) is unreachable for any hidden
     card. The glyph branches survive as the Amendment 4 fallback — they
     render in any environment without built artwork (`hasTarotArt`). -->
{#if faceDown || !card}
	{#if hasTarotArt}
		<!-- Both themed Adherent backs render; CSS shows the one matching the
		     active data-theme. The hidden one is lazy, so it is not fetched
		     until a theme switch reveals it. Backs carry no card identity, so
		     rendering both discloses nothing. -->
		<div class="card back art {size}" role="img" aria-label="Face-down card">
			<span class="back-variant back-light"><TarotCardImage sources={getTarotBackSources('adherent-parchment')} sizes={imageSizes} /></span>
			<span class="back-variant back-dark"><TarotCardImage sources={getTarotBackSources('adherent-dark')} sizes={imageSizes} /></span>
		</div>
	{:else}
		<div class="card back {size}" role="img" aria-label="Face-down card">
			<span class="mark">❦</span>
		</div>
	{/if}
{:else if hasTarotArt}
	<div class="art-frame {size}">
		<div class="card art face {size}" role="img" aria-label={card.label} data-card-id={card.id}>
			<TarotCardImage sources={getTarotFaceSources(card.id)} sizes={imageSizes} />
			<footer class="label">{card.label}</footer>
		</div>
		<button
			type="button"
			class="enlarge"
			aria-label="Enlarge {card.label}"
			onclick={() => (enlarged = true)}
		>
			⤢
		</button>
		{#if enlarged}
			<TarotCardDialog {card} onclose={() => (enlarged = false)} />
		{/if}
	</div>
{:else if card.kind === 'major'}
	<div class="card major {size}" role="img" aria-label={card.label} data-card-id={card.id}>
		<span class="mnum">{card.value}</span>
		<span class="mname">{card.label}</span>
	</div>
{:else}
	<div class="card minor suit-{card.suit} {size}" role="img" aria-label={card.label} data-card-id={card.id}>
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
	/* Archival Frame: fixed width, height grows with the artwork's intrinsic
	 * ratio plus the label footer — the frame fits the art, never the
	 * reverse (no crop, no cover). The padding is the neutral mat; it also
	 * keeps the border-radius from clipping artwork pixels. */
	.card.art {
		height: auto;
		padding: 0.28rem;
		gap: 0.15rem;
	}
	.card.art.sm {
		padding: 0.18rem;
	}
	.card.art .label {
		width: 100%;
		padding: 0.05rem 0.1rem 0;
		font-family: var(--font-heading);
		font-size: 0.62rem;
		line-height: 1.15;
		color: var(--ink);
	}
	.card.art.sm .label {
		font-size: 0.5rem;
	}
	.art-frame {
		position: relative;
		width: fit-content;
	}
	.enlarge {
		position: absolute;
		top: 0.15rem;
		right: 0.15rem;
		padding: 0 0.25rem;
		border: none;
		border-radius: 4px;
		background: color-mix(in oklab, var(--parchment) 75%, transparent);
		color: var(--ink);
		font-size: 0.8rem;
		line-height: 1.3;
		cursor: pointer;
		opacity: 0;
	}
	.art-frame:hover .enlarge,
	.art-frame:focus-within .enlarge {
		opacity: 1;
	}
	/* No hover on touch devices: an opacity-0 button would still be a live,
	 * invisible tap target — keep it faintly visible instead. */
	@media (hover: none) {
		.enlarge {
			opacity: 0.55;
		}
	}
	/* The art back keeps the glyph back's `.back` class for test/selector
	 * compatibility, but its striped gradient must not bleed into the mat —
	 * the Archival Frame's mat is neutral. */
	.card.back.art {
		background: var(--parchment);
	}
	/* Theme-selected Adherent back, paired for CONTRAST: the dark treatment
	 * on the light theme, the parchment treatment on worm-dark — a hidden
	 * card's whole job is to read as "face down" at a glance, so the back
	 * must pop against the page, not match it. Pure CSS on the same
	 * data-theme attribute the rest of the app uses. */
	.back-variant {
		display: block;
		width: 100%;
	}
	.back-light {
		display: none;
	}
	:global([data-theme='worm-dark']) .back-dark {
		display: none;
	}
	:global([data-theme='worm-dark']) .back-light {
		display: block;
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
