<script lang="ts">
	import RuleArticle from '$lib/components/rules/RuleArticle.svelte';
	import RulebookThanks from '$lib/components/rules/RulebookThanks.svelte';
	import { sectionLabel } from '$lib/content/sections';
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { clearPhraseHighlights, highlightPhrase } from '$lib/search/highlight-dom';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const label = $derived(sectionLabel(data.section));

	afterNavigate(() => {
		// Always clear previous highlight state FIRST: navigating Back to a plain
		// section URL (no hash) reuses this component, and the early returns
		// below must not preserve the previous navigation's marks or flash.
		for (const el of document.querySelectorAll('.anchored')) el.classList.remove('anchored');
		clearPhraseHighlights();
		const id = location.hash.slice(1);
		if (!id) return;
		const target = document.getElementById(id);
		if (!(target instanceof HTMLElement)) return;
		target.focus({ preventScroll: true });
		// When the search result matched a literal phrase (?hl=…), scroll to the
		// phrase itself, highlighted in place; otherwise land at the article top.
		const hl = page.url.searchParams.get('hl');
		const mark = hl ? highlightPhrase(target, hl) : null;
		// Double rAF: the second frame runs after SvelteKit's own scroll-to-hash,
		// which would otherwise override the phrase scroll back to the article top.
		requestAnimationFrame(() => {
			target.classList.add('anchored');
			requestAnimationFrame(() => {
				if (mark) mark.scrollIntoView({ block: 'center' });
				else target.scrollIntoView({ block: 'start' });
			});
		});
	});
</script>

<svelte:head><title>{label} rules — Guild Book</title></svelte:head>

<section class="section">
	<p class="crumb"><a href="/rules">← All rules</a></p>
	<h1>{label}</h1>
	{#each data.rules as rule (rule.id)}
		<RuleArticle {rule} />
	{/each}

	<RulebookThanks />
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
	/* Runtime-inserted by the search deep link (highlight-dom.ts). */
	.section :global(mark.phrase-hl) {
		background: color-mix(in oklab, var(--accent) 32%, transparent);
		color: inherit;
		border-radius: 2px;
		padding: 0 0.05em;
	}
</style>
