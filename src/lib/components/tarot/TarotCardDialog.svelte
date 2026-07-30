<script lang="ts">
	import type { DrawnCard } from '$lib/tarot/protocol';
	import { getTarotFaceSources } from '$lib/tarot/art';
	import TarotCardImage from './TarotCardImage.svelte';

	/**
	 * The enlargement dialog (issue #10 Task 4): the same uncropped artwork at
	 * the 960 tier in a native `<dialog>`. Only ever mounted for a card the
	 * viewer already sees face-up, so resolving the face here discloses
	 * nothing new. Native `showModal()` gives Esc-to-close and returns focus
	 * to the trigger on close.
	 */
	interface Props {
		card: DrawnCard;
		onclose: () => void;
	}
	let { card, onclose }: Props = $props();

	let dialog: HTMLDialogElement;
	$effect(() => {
		dialog.showModal();
	});
</script>

<dialog
	bind:this={dialog}
	{onclose}
	onclick={(event) => {
		if (event.target === dialog) dialog.close();
	}}
	aria-label={card.label}
>
	<TarotCardImage sources={getTarotFaceSources(card.id)} alt={card.label} sizes="min(80vw, 52vh)" eager />
	<div class="bar">
		<span class="title">{card.label}</span>
		<button type="button" onclick={() => dialog.close()}>Close</button>
	</div>
</dialog>

<style>
	dialog {
		max-width: min(85vw, 26rem);
		padding: 0.6rem;
		border: 1px solid var(--ink);
		border-radius: 10px;
		background: var(--parchment);
	}
	dialog::backdrop {
		background: rgba(0, 0, 0, 0.55);
	}
	.bar {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
		margin-top: 0.5rem;
	}
	.title {
		font-family: var(--font-heading);
	}
</style>
