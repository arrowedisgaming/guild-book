<script lang="ts">
	import TarotTable from '$lib/components/tarot/TarotTable.svelte';
	import TestOfFate from '$lib/components/tarot/TestOfFate.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let mode = $state<'table' | 'test'>('table');
</script>

<svelte:head><title>The Deck — Guild Book</title></svelte:head>

<section class="deck-page">
	<h1>The Deck</h1>
	<p class="lede">
		A virtual tarot deck for His Majesty the Worm. Draw freely, or run a guided test of fate.
	</p>

	<div class="tabs" role="tablist">
		<button role="tab" aria-selected={mode === 'table'} class:sel={mode === 'table'} onclick={() => (mode = 'table')}>
			Table deck
		</button>
		<button role="tab" aria-selected={mode === 'test'} class:sel={mode === 'test'} onclick={() => (mode = 'test')}>
			Test of fate
		</button>
	</div>

	{#if mode === 'table'}
		<TarotTable config={data.tarot} />
	{:else}
		<TestOfFate config={data.tarot} />
	{/if}
</section>

<style>
	.deck-page {
		max-width: 48rem;
		margin: 0 auto;
	}
	.lede {
		color: var(--ink-soft);
		margin-top: -0.25rem;
	}
	.tabs {
		display: flex;
		gap: 0.25rem;
		margin: 1.25rem 0 1.5rem;
		border-bottom: 1px solid color-mix(in oklab, var(--ink) 15%, transparent);
	}
	.tabs button {
		border: none;
		background: none;
		padding: 0.5rem 0.9rem;
		font-family: var(--font-subhead);
		color: var(--ink-soft);
		cursor: pointer;
		border-bottom: 2px solid transparent;
		margin-bottom: -1px;
	}
	.tabs button.sel {
		color: var(--accent);
		border-bottom-color: var(--accent);
	}
</style>
