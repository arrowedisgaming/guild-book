<script lang="ts">
	import RuleArticle from '$lib/components/rules/RuleArticle.svelte';
	import { sectionLabel } from '$lib/content/sections';
	import { afterNavigate } from '$app/navigation';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const label = $derived(sectionLabel(data.section));

	afterNavigate(() => {
		const id = location.hash.slice(1);
		if (!id) return;
		const target = document.getElementById(id);
		if (!(target instanceof HTMLElement)) return;
		// Clear previous targets so only the current article is highlighted, and
		// so re-anchoring the same article restarts its flash animation.
		for (const el of document.querySelectorAll('.anchored')) el.classList.remove('anchored');
		requestAnimationFrame(() => target.classList.add('anchored'));
		target.focus({ preventScroll: true });
		target.scrollIntoView({ block: 'start' });
	});
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
