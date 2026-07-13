<script lang="ts">
	import { Moon, Sun } from '@lucide/svelte';
	import { theme } from '$lib/stores/theme';

	function toggle() {
		theme.update((t) => (t === 'worm-dark' ? 'parchment-light' : 'worm-dark'));
	}
</script>

<button
	type="button"
	class="toggle"
	onclick={toggle}
	aria-label={$theme === 'worm-dark' ? 'Switch to light mode' : 'Switch to dark mode'}
	title={$theme === 'worm-dark' ? 'Switch to light mode' : 'Switch to dark mode'}
>
	{#if $theme === 'worm-dark'}
		<Sun size={17} strokeWidth={1.8} aria-hidden="true" />
	{:else}
		<Moon size={17} strokeWidth={1.8} aria-hidden="true" />
	{/if}
</button>

<style>
	.toggle {
		display: inline-grid;
		place-items: center;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		background: transparent;
		color: var(--ink);
		width: 1.9rem;
		height: 1.9rem;
		border-radius: 999px;
		cursor: pointer;
	}
	.toggle:hover {
		border-color: var(--accent);
		color: var(--accent);
	}
</style>
