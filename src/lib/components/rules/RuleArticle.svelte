<script lang="ts">
	import { renderMarkdown } from '$lib/utils/markdown';
	import type { RuleEntry } from '$lib/types/content-pack';

	let { rule }: { rule: RuleEntry } = $props();
	let bodyHtml = $derived(renderMarkdown(rule.body));
</script>

<article id={rule.id} class="rule" tabindex="-1">
	{#each rule.aliases ?? [] as alias (alias)}
		<!-- Retired-id anchor: the old permanent URL must keep landing here. -->
		<span id={alias} aria-hidden="true"></span>
	{/each}
	<h3>{rule.title}</h3>
	<div class="body">
		<!-- eslint-disable-next-line svelte/no-at-html-tags -- content is authored + escaped by renderMarkdown -->
		{@html bodyHtml}
	</div>
	<!-- Legacy curated tags are metadata only (the index page's fallback filter
	     still reads them); with full text + real search they aren't shown. -->
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
	.body :global(table) {
		display: block;
		width: 100%;
		overflow-x: auto;
		border-collapse: collapse;
		margin: 0.9rem 0;
		font-size: 0.92em;
	}
	.body :global(th),
	.body :global(td) {
		border: 1px solid color-mix(in oklab, var(--ink) 30%, transparent);
		padding: 0.5rem 0.75rem;
		text-align: center;
		vertical-align: middle;
	}
	.body :global(th) {
		font-family: var(--font-subhead);
		background: color-mix(in oklab, var(--ink) 6%, transparent);
	}
	.rule:focus {
		outline: none;
	}
	/* Keyboard-driven focus keeps a visible indicator after the flash ends;
	 * programmatic focus from a pointer click stays quiet. */
	.rule:focus-visible {
		outline: 2px solid color-mix(in oklab, var(--accent) 60%, transparent);
		outline-offset: 4px;
	}
	.rule:target,
	.rule:global(.anchored) {
		animation: rule-flash 1.6s ease-out 1;
	}
	@keyframes rule-flash {
		from {
			background: color-mix(in oklab, var(--accent) 18%, transparent);
		}
		to {
			background: transparent;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.rule:target,
		.rule:global(.anchored) {
			animation: none;
			outline: 2px solid color-mix(in oklab, var(--accent) 60%, transparent);
			outline-offset: 4px;
		}
	}
</style>
