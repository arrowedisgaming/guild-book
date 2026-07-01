<script lang="ts">
	import CharacterSheet from '$lib/components/character/CharacterSheet.svelte';
	import SheetActions from '$lib/components/character/SheetActions.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>{data.view.name} — Guild Book</title></svelte:head>

<div class="sheet-page">
	<p class="crumb"><a href="/characters">← My Adventurers</a></p>

	{#if data.isDraft}
		<p class="draft-note">This adventurer is a <strong>draft</strong>.</p>
	{/if}

	<CharacterSheet view={data.view} />

	<div class="actions-wrap">
		<SheetActions view={data.view} characterId={data.id} shareId={data.shareId} isDraft={data.isDraft} />
	</div>
</div>

<style>
	.sheet-page {
		max-width: 48rem;
		margin: 0 auto;
	}
	.crumb {
		font-family: var(--font-subhead);
		font-size: 0.9rem;
	}
	.crumb a {
		color: var(--ink-soft);
		text-decoration: none;
	}
	.draft-note {
		color: var(--ink-soft);
		font-size: 0.9rem;
	}
	.actions-wrap {
		margin-top: 1.25rem;
	}
</style>
