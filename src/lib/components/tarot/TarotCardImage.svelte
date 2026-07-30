<script lang="ts">
	import type { TarotImageSources } from '$lib/types/tarot-art';

	/**
	 * One responsive, uncropped tarot image (issue #10 Task 4). Purely
	 * presentational: it renders exactly the sources it is handed and holds no
	 * card identity of its own — the privacy decision of WHICH sources to
	 * resolve stays in `TarotCard.svelte`, before this component is reached.
	 */
	interface Props {
		sources: TarotImageSources;
		/** Empty by default: the labelled container (`role="img"` in
		 * `TarotCard`) carries the accessible name; the dialog passes a real
		 * alt instead. */
		alt?: string;
		sizes?: string;
		/** Above-the-fold usage (the enlargement dialog) loads eagerly;
		 * everything else is lazy. */
		eager?: boolean;
	}
	let { sources, alt = '', sizes = '240px', eager = false }: Props = $props();
</script>

<picture>
	<source type="image/avif" srcset={sources.avifSrcset} {sizes} />
	<source type="image/webp" srcset={sources.webpSrcset} {sizes} />
	<img
		src={sources.fallbackWebp}
		{alt}
		width={sources.width}
		height={sources.height}
		loading={eager ? 'eager' : 'lazy'}
		decoding="async"
	/>
</picture>

<style>
	picture {
		display: block;
		width: 100%;
		min-height: 0;
	}
	/* Contain, never cover: the complete artwork stays visible at every size
	 * (issue #10 global constraint — no crop). */
	img {
		display: block;
		width: 100%;
		height: auto;
		object-fit: contain;
	}
</style>
