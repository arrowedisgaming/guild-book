<script lang="ts">
	import RulesSearch from '$lib/components/rules/RulesSearch.svelte';
	import RuleArticle from '$lib/components/rules/RuleArticle.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let query = $state('');

	const sectionLabel = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

	let filtered = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q) return data.rules;
		return data.rules.filter((r) =>
			[r.title, r.body, ...r.tags].join(' ').toLowerCase().includes(q)
		);
	});

	let bySection = $derived(
		data.sections
			.map((section) => ({ section, rules: filtered.filter((r) => r.section === section) }))
			.filter((g) => g.rules.length > 0)
	);
</script>

<svelte:head><title>Rules — Guild Book</title></svelte:head>

<section class="rules">
	<h1>Rules Reference</h1>
	<p class="lede">
		A quick reference for His Majesty the Worm. <em>Placeholder summaries — full text pending.</em>
	</p>

	<RulesSearch bind:value={query} />

	{#if bySection.length === 0}
		<p class="empty">No rules match “{query}”.</p>
	{:else}
		<nav class="jump" aria-label="Sections">
			{#each bySection as g (g.section)}
				<a href={`/rules/${g.section}`}>{sectionLabel(g.section)}</a>
			{/each}
		</nav>

		{#each bySection as g (g.section)}
			<section class="group">
				<h2>{sectionLabel(g.section)}</h2>
				{#each g.rules as rule (rule.id)}
					<RuleArticle {rule} />
				{/each}
			</section>
		{/each}
	{/if}
</section>

<style>
	.rules {
		max-width: 46rem;
		margin: 0 auto;
	}
	.lede {
		color: var(--ink-soft);
		margin-top: -0.25rem;
	}
	.jump {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		margin: 1.25rem 0;
		font-family: var(--font-subhead);
		font-size: 0.9rem;
	}
	.group {
		margin-top: 1.5rem;
	}
	.group h2 {
		font-size: 1.35rem;
		border-bottom: 2px solid color-mix(in oklab, var(--accent) 40%, transparent);
		padding-bottom: 0.25rem;
	}
	.empty {
		color: var(--ink-soft);
		margin-top: 1.25rem;
	}
</style>
