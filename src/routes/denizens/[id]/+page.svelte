<script lang="ts">
	import DenizenStatBlock from '$lib/components/denizens/DenizenStatBlock.svelte';
	import DenizenExportButtons from '$lib/components/denizens/DenizenExportButtons.svelte';
	import { goto } from '$app/navigation';
	import { denizenBuilder } from '$lib/stores/denizen-builder';
	import { draftFromDefinition } from '$lib/engine/denizen-builder';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Load the book entry into the builder as a fresh, pre-filled custom
	// denizen — saving it creates a new row, the book entry is untouched.
	function customize() {
		denizenBuilder.startFrom(draftFromDefinition(data.denizen));
		goto('/denizens/build');
	}
</script>

<svelte:head><title>{data.denizen.name} — Guild Book</title></svelte:head>

<section class="denizen">
	<p class="crumb"><a href="/denizens">← All denizens</a></p>
	<DenizenStatBlock
		denizen={data.denizen}
		themeName={data.themeName}
		threatName={data.threatName}
		headingLevel={1}
	/>
	<DenizenExportButtons
		denizen={data.denizen}
		themeName={data.themeName}
		threatName={data.threatName}
	/>
	{#if data.builderReady}
		<button type="button" class="customize" onclick={customize}>
			Customize in the builder
		</button>
		<p class="customize-hint">
			Opens a pre-filled copy in the denizen builder — the book entry stays as it is.
		</p>
	{/if}
</section>

<style>
	.denizen {
		max-width: 46rem;
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
	.customize {
		font: inherit;
		font-family: var(--font-subhead);
		font-size: 0.9rem;
		margin-top: 1rem;
		padding: 0.4rem 1rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 4px;
		background: none;
		color: var(--ink);
		cursor: pointer;
	}
	.customize-hint {
		font-size: 0.8rem;
		color: var(--ink-soft);
		margin: 0.35rem 0 0;
	}
</style>
