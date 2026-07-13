<script lang="ts">
	import RuleArticle from '$lib/components/rules/RuleArticle.svelte';
	import { sectionLabel } from '$lib/content/sections';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const label = $derived(sectionLabel(data.section));
</script>

<svelte:head><title>{label} rules — Guild Book</title></svelte:head>

<section class="section">
	<p class="crumb"><a href="/rules">← All rules</a></p>
	<h1>{label}</h1>
	{#each data.rules as rule (rule.id)}
		<RuleArticle {rule} />
	{/each}
</section>

<style>
	.section {
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
