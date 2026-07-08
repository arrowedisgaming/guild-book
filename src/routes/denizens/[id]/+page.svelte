<script lang="ts">
	import DenizenStatBlock from '$lib/components/denizens/DenizenStatBlock.svelte';
	import DenizenExportButtons from '$lib/components/denizens/DenizenExportButtons.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
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
</style>
