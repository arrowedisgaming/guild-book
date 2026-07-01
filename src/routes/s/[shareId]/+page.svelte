<script lang="ts">
	import CharacterSheet from '$lib/components/character/CharacterSheet.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>{data.view.name} — Guild Book</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="shared">
	<p class="ribbon">A shared adventurer from Guild Book</p>
	<CharacterSheet view={data.view} />
	<p class="cta"><a href="/create/hmtw/identity">Build your own adventurer →</a></p>
</div>

<style>
	.shared {
		max-width: 48rem;
		margin: 0 auto;
	}
	.ribbon {
		font-family: var(--font-subhead);
		color: var(--ink-soft);
		font-size: 0.85rem;
		margin: 0 0 0.75rem;
	}
	.cta {
		margin-top: 1.25rem;
		text-align: center;
	}
</style>
