<script lang="ts">
	import { renderMarkdown } from '$lib/utils/markdown';
	import type { RuleEntry } from '$lib/types/content-pack';

	let { rule }: { rule: RuleEntry } = $props();
	let bodyHtml = $derived(renderMarkdown(rule.body));
</script>

<article id={rule.id} class="rule">
	<h3>{rule.title}</h3>
	<div class="body">
		<!-- eslint-disable-next-line svelte/no-at-html-tags -- content is authored + escaped by renderMarkdown -->
		{@html bodyHtml}
	</div>
	{#if rule.tags.length}
		<div class="tags">{#each rule.tags as tag}<span class="tag">{tag}</span>{/each}</div>
	{/if}
</article>

<style>
	.rule {
		padding: 1rem 0;
		border-bottom: 1px solid color-mix(in oklab, var(--ink) 12%, transparent);
	}
	h3 {
		margin: 0 0 0.4rem;
		font-size: 1.2rem;
	}
	.body :global(p) {
		margin: 0 0 0.6rem;
	}
	.body :global(h4),
	.body :global(h5),
	.body :global(h6) {
		margin: 1rem 0 0.35rem;
		font-family: var(--font-subhead);
		font-size: 1rem;
		color: color-mix(in oklab, var(--accent) 80%, var(--ink));
	}
	.body :global(ul) {
		margin: 0 0 0.6rem;
		padding-left: 1.2rem;
	}
	.body :global(li) {
		margin: 0.15rem 0;
	}
	.body :global(code) {
		background: color-mix(in oklab, var(--ink) 8%, transparent);
		padding: 0.05rem 0.3rem;
		border-radius: 3px;
		font-size: 0.9em;
	}
	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-top: 0.5rem;
	}
	.tag {
		font-size: 0.72rem;
		padding: 0.05rem 0.45rem;
		border: 1px solid color-mix(in oklab, var(--ink) 18%, transparent);
		border-radius: 999px;
		color: var(--ink-soft);
	}
</style>
