<script lang="ts">
	import DecoCorner from './DecoCorner.svelte';
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();
</script>

<div class="frame">
	<DecoCorner corner="tl" />
	<DecoCorner corner="tr" />
	<DecoCorner corner="bl" />
	<DecoCorner corner="br" />
	<div class="inner">{@render children()}</div>
</div>

<style>
	.frame {
		position: relative;
		border: 1px solid color-mix(in oklab, var(--ink) 22%, transparent);
		border-radius: 4px;
		padding: 2rem;
		background: color-mix(in oklab, var(--surface) 70%, var(--parchment));
	}
	.frame :global(.deco) {
		position: absolute;
	}
	.frame :global(.deco.tl) {
		top: -2px;
		left: -2px;
	}
	.frame :global(.deco.tr) {
		top: -2px;
		right: -2px;
	}
	.frame :global(.deco.bl) {
		bottom: -2px;
		left: -2px;
	}
	.frame :global(.deco.br) {
		bottom: -2px;
		right: -2px;
	}
	.inner {
		position: relative;
	}
</style>
