<script lang="ts">
	import { page } from '$app/state';
	import RulesSearch from '$lib/components/rules/RulesSearch.svelte';
	import RulebookThanks from '$lib/components/rules/RulebookThanks.svelte';
	import { sectionLabel } from '$lib/content/sections';
	import {
		getRulesSearch,
		hitHref,
		type RulesSearchEngine,
		type RuleSearchHit
	} from '$lib/search/rules-search';
	import { buildSnippet } from '$lib/search/snippets';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let query = $state(page.url.searchParams.get('q') ?? '');
	let engine = $state<RulesSearchEngine | null>(null);
	let engineFailed = $state(false);
	let engineLoading = $derived(!engine && !engineFailed);

	// SvelteKit reuses this component when only ?q= changes, so sync from the
	// URL; local typing still wins between navigations.
	$effect(() => {
		query = page.url.searchParams.get('q') ?? '';
	});

	$effect(() => {
		getRulesSearch(page.data.packVersion as string)
			.then((e) => (engine = e))
			.catch(() => (engineFailed = true));
	});

	let hits = $derived.by<RuleSearchHit[] | null>(() => {
		if (!query.trim() || !engine) return null;
		return engine.search(query);
	});

	// Fallback while the engine loads (or if it failed): substring over the SSR TOC.
	let fallbackToc = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q) return data.toc;
		return data.toc.filter((r) => [r.title, ...r.tags].join(' ').toLowerCase().includes(q));
	});

	let bySection = $derived(
		data.sections
			.map((section) => ({
				section,
				rules: (query.trim() ? fallbackToc : data.toc).filter((r) => r.section === section)
			}))
			.filter((g) => g.rules.length > 0)
	);
</script>

<svelte:head><title>Rules — Guild Book</title></svelte:head>

<section class="rules">
	<h1>Rules Reference</h1>
	<p class="lede">
		The full text of His Majesty the Worm chapters 1–9, reproduced from the core rulebook, plus
		selected gamemastering and sorcery entries. Pick a chapter or search the whole reference.
	</p>

	<RulesSearch bind:value={query} />

	{#if query.trim() && hits}
		{#if hits.length === 0}
			<p class="empty">No rules match “{query}”.</p>
		{:else}
			<ol class="results">
				{#each hits as hit (hit.doc.id)}
					<li>
						<a href={hitHref(hit)}>{hit.doc.title}</a>
						<span class="crumb">{sectionLabel(hit.doc.section)}</span>
						<p class="snippet">
							{#each buildSnippet(hit.doc.body, hit.terms, 220, hit.phrase) as part}
								{#if part.marked}<mark>{part.text}</mark>{:else}{part.text}{/if}
							{/each}
						</p>
					</li>
				{/each}
			</ol>
		{/if}
	{:else}
		{#if query.trim() && engineFailed}
			<p class="empty">Full-text search is unavailable — filtering titles only.</p>
		{/if}
		{#if bySection.length === 0}
			{#if query.trim() && engineLoading}
				<!-- The title-only fallback can't see body matches; don't claim "no
				     match" for a body-only query while the engine is still loading. -->
				<p class="empty">Searching the rulebook…</p>
			{:else}
				<p class="empty">No rules match “{query}”.</p>
			{/if}
		{:else}
			<nav class="jump" aria-label="Chapters">
				{#each bySection as g (g.section)}
					<a href={`/rules/${g.section}`}>{sectionLabel(g.section)}</a>
				{/each}
			</nav>
			{#each bySection as g (g.section)}
				<section class="group">
					<h2>
						<a href={`/rules/${g.section}`}>{sectionLabel(g.section)}</a>
						<span class="count">{g.rules.length} entries</span>
					</h2>
					<ul class="toc">
						{#each g.rules as rule (rule.id)}
							<li><a href={`/rules/${g.section}#${rule.id}`}>{rule.title}</a></li>
						{/each}
					</ul>
				</section>
			{/each}
		{/if}
	{/if}

	<RulebookThanks />
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
	.results {
		list-style: none;
		padding: 0;
		margin: 1.25rem 0 0;
	}
	.results li {
		padding: 0.6rem 0;
		border-bottom: 1px solid color-mix(in oklab, var(--ink) 12%, transparent);
	}
	.results a {
		font-family: var(--font-subhead);
		font-weight: 600;
	}
	.results .crumb {
		margin-left: 0.5rem;
		font-size: 0.8rem;
		color: var(--ink-soft);
	}
	.results .snippet {
		margin: 0.2rem 0 0;
		font-size: 0.9rem;
		color: var(--ink-soft);
	}
	.results mark {
		background: color-mix(in oklab, var(--accent) 30%, transparent);
		color: inherit;
		border-radius: 2px;
	}
	.count {
		margin-left: 0.5rem;
		font-size: 0.8rem;
		font-weight: normal;
		color: var(--ink-soft);
	}
</style>
