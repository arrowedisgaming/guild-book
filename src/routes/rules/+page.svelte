<script lang="ts">
	import RulesSearch from '$lib/components/rules/RulesSearch.svelte';
	import { sectionLabel } from '$lib/content/sections';
	import type { RuleEntry } from '$lib/types/content-pack';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let query = $state('');

	// Full-text search needs the rule bodies, which the index deliberately does
	// not ship. Lazy-fetch the static content-pack file once (CDN-cached); until
	// it arrives, search falls back to titles + tags from the SSR TOC.
	let bodyById = $state<Map<string, string>>(new Map());
	$effect(() => {
		fetch('/content-packs/hmtw/rules.json')
			.then((r) => (r.ok ? (r.json() as Promise<RuleEntry[]>) : []))
			.then((rules) => {
				bodyById = new Map(rules.map((r) => [r.id, r.body]));
			})
			.catch(() => {});
	});

	let filtered = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q) return data.toc;
		return data.toc.filter((r) =>
			[r.title, ...r.tags, bodyById.get(r.id) ?? ''].join(' ').toLowerCase().includes(q)
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
		The currently available Chapter 1 rules from His Majesty the Worm, reproduced from the core
		rulebook. Pick a topic or search this reference.
	</p>

	<RulesSearch bind:value={query} />

	{#if bySection.length === 0}
		<p class="empty">No rules match “{query}”.</p>
	{:else}
		<nav class="jump" aria-label="Chapters">
			{#each bySection as g (g.section)}
				<a href={`/rules/${g.section}`}>{sectionLabel(g.section)}</a>
			{/each}
		</nav>

		{#each bySection as g (g.section)}
			<section class="group">
				<h2><a href={`/rules/${g.section}`}>{sectionLabel(g.section)}</a></h2>
				<ul class="toc">
					{#each g.rules as rule (rule.id)}
						<li><a href={`/rules/${g.section}#${rule.id}`}>{rule.title}</a></li>
					{/each}
				</ul>
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
	.group h2 a {
		color: inherit;
		text-decoration: none;
	}
	.group h2 a:hover {
		color: var(--accent);
	}
	.toc {
		list-style: none;
		padding: 0;
		margin: 0.6rem 0 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
		gap: 0.15rem 1rem;
	}
	.toc a {
		display: block;
		padding: 0.2rem 0;
		font-size: 0.95rem;
	}
	.empty {
		color: var(--ink-soft);
		margin-top: 1.25rem;
	}
</style>
