<script lang="ts">
	// An original corner flourish (a curling worm-vine), authored here — not
	// reused from the His Majesty the Worm book art. `corner` rotates it to the
	// right position; colour follows `currentColor`.
	let { corner = 'tl' }: { corner?: 'tl' | 'tr' | 'bl' | 'br' } = $props();

	const rotation: Record<string, number> = { tl: 0, tr: 90, br: 180, bl: 270 };
</script>

<svg
	class="deco {corner}"
	viewBox="0 0 64 64"
	aria-hidden="true"
	style="transform: rotate({rotation[corner]}deg)"
>
	<path
		d="M4 60 C4 34 4 12 26 8 C10 12 12 26 24 26 C34 26 30 14 22 16"
		fill="none"
		stroke="currentColor"
		stroke-width="1.6"
		stroke-linecap="round"
	/>
	<circle cx="21.5" cy="19" r="1.6" fill="currentColor" />
	<path d="M4 60 L4 46 M4 60 L18 60" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
</svg>

<style>
	.deco {
		width: 3.5rem;
		height: 3.5rem;
		color: color-mix(in oklab, var(--accent) 65%, var(--ink));
		opacity: 0.75;
	}
</style>
