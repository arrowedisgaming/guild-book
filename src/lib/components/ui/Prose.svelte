<script lang="ts">
	import { renderMarkdown } from '$lib/utils/markdown';

	// Renders a content-pack markdown field (descriptions, effects, rules bodies)
	// as safe HTML. renderMarkdown escapes first, so {@html} is safe here even
	// though the content is authored, not user-supplied.
	let { text = '', class: className = '' }: { text?: string; class?: string } = $props();
	let html = $derived(renderMarkdown(text ?? ''));
</script>

<!-- eslint-disable-next-line svelte/no-at-html-tags -- content is authored + escaped by renderMarkdown -->
<div class="prose {className}">{@html html}</div>

<style>
	.prose :global(p) {
		margin: 0 0 0.5rem;
	}
	.prose :global(p:last-child) {
		margin-bottom: 0;
	}
	.prose :global(ul) {
		margin: 0 0 0.5rem;
		padding-left: 1.15rem;
	}
	.prose :global(li) {
		margin: 0.1rem 0;
	}
	.prose :global(h4),
	.prose :global(h5),
	.prose :global(h6) {
		margin: 0.6rem 0 0.25rem;
		font-family: var(--font-subhead);
		font-size: 0.95em;
	}
	.prose :global(code) {
		background: color-mix(in oklab, var(--ink) 8%, transparent);
		padding: 0.05rem 0.3rem;
		border-radius: 3px;
		font-size: 0.9em;
	}
	.prose :global(table) {
		display: block;
		width: 100%;
		overflow-x: auto;
		border-collapse: collapse;
		margin: 0.75rem 0;
		font-size: 0.9em;
	}
	.prose :global(th),
	.prose :global(td) {
		border: 1px solid color-mix(in oklab, var(--ink) 18%, transparent);
		padding: 0.35rem 0.5rem;
		text-align: left;
		vertical-align: top;
	}
	.prose :global(th) {
		font-family: var(--font-subhead);
		background: color-mix(in oklab, var(--ink) 5%, transparent);
	}
</style>
