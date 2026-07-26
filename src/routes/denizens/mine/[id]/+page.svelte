<script lang="ts">
	import DenizenStatBlock from '$lib/components/denizens/DenizenStatBlock.svelte';
	import DenizenExportButtons from '$lib/components/denizens/DenizenExportButtons.svelte';
	import { goto } from '$app/navigation';
	import { denizenBuilder } from '$lib/stores/denizen-builder';
	import { toDenizenDefinition } from '$lib/engine/denizen-builder';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// The stored draft is authoritative — materialize fresh on every render.
	let denizen = $derived(toDenizenDefinition(data.draft));

	function edit() {
		denizenBuilder.loadForEditing(data.draft, data.id, data.version);
		goto('/denizens/build');
	}
</script>

<svelte:head><title>{denizen.name} — My Denizens — Guild Book</title></svelte:head>

<section class="saved">
	<p class="crumbs"><a href="/denizens/mine">← My denizens</a></p>
	<DenizenExportButtons {denizen} themeName={data.themeName} threatName={data.threatName} />
	<button type="button" class="edit" onclick={edit}>Edit in the builder</button>
	<div class="block">
		<DenizenStatBlock {denizen} themeName={data.themeName} threatName={data.threatName} />
	</div>
</section>

<style>
	.saved {
		max-width: 46rem;
		margin: 0 auto;
	}
	.crumbs {
		font-size: 0.9rem;
	}
	.edit {
		font: inherit;
		font-family: var(--font-subhead);
		font-size: 0.9rem;
		margin: 0.5rem 0 1rem;
		padding: 0.4rem 1rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 4px;
		background: none;
		color: var(--ink);
		cursor: pointer;
	}
	.block {
		padding: 1rem 1.25rem;
		border: 1px solid color-mix(in oklab, var(--ink) 18%, transparent);
		border-radius: 6px;
	}
</style>
