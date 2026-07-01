<script lang="ts">
	import { theme } from '$lib/stores/theme';

	function toggle() {
		theme.update((t) => (t === 'worm-dark' ? 'parchment-light' : 'worm-dark'));
	}
</script>

<button
	type="button"
	class="toggle"
	onclick={toggle}
	aria-label={$theme === 'worm-dark' ? 'Switch to parchment theme' : 'Switch to dark theme'}
	title={$theme === 'worm-dark' ? 'Parchment' : 'Worm (dark)'}
>
	{$theme === 'worm-dark' ? '☾' : '☀'}
</button>

<style>
	.toggle {
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		background: transparent;
		color: var(--ink);
		width: 1.9rem;
		height: 1.9rem;
		border-radius: 999px;
		cursor: pointer;
		font-size: 0.95rem;
		line-height: 1;
	}
	.toggle:hover {
		border-color: var(--accent);
		color: var(--accent);
	}
</style>
