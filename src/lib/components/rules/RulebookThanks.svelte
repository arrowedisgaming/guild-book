<script lang="ts">
	import OrnamentalBorder from '$lib/components/decoration/OrnamentalBorder.svelte';
</script>

<!-- Genuinely complementary to the rules text, so an <aside> landmark rather
     than a plain <div>: a screen reader user can skip it, and find it again. -->
<aside class="thanks" data-testid="rulebook-thanks" aria-labelledby="rulebook-thanks-heading">
	<OrnamentalBorder>
		<h2 id="rulebook-thanks-heading">With thanks to Josh McCrowell</h2>
		<p>
			<strong>His Majesty the Worm</strong> is his work. It is shown here only because he
			<a href="https://www.hismajestytheworm.games/open-license" target="_blank" rel="noopener"
				>licensed the game</a
			> generously enough for people like us to build from it.
		</p>
		<p>
			A searchable reference is no substitute for the book itself. It's a beautiful object, and
			buying it is the best way to support Josh and the game.
		</p>
		<p class="cta">
			<span>Learn more &amp; Purchase</span>
			<a
				class="buy"
				href="https://www.hismajestytheworm.games/his-majesty-the-worm"
				target="_blank"
				rel="noopener"
				aria-label="Learn more and purchase His Majesty the Worm">His Majesty the Worm</a
			>
		</p>
	</OrnamentalBorder>
</aside>

<style>
	.thanks {
		max-width: 46rem;
		margin: 3rem auto 0;
		text-align: center;
	}
	.thanks h2 {
		margin: 0 0 0.9rem;
		font-family: var(--font-subhead);
		font-size: 1.15rem;
	}
	.thanks p:not(.cta) {
		margin: 0 0 0.75rem;
		color: var(--ink-soft);
		font-size: 0.95rem;
		line-height: 1.55;
		text-wrap: pretty;
	}
	.cta {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
		margin: 1.35rem 0 0;
		font-family: var(--font-subhead);
		color: var(--ink-soft);
		font-size: 0.95rem;
	}
	.buy {
		max-width: 100%;
		padding: 0.5rem 1.1rem;
		border: 1px solid color-mix(in oklab, var(--accent) 55%, transparent);
		border-radius: 4px;
		color: var(--accent);
		font-weight: 600;
		text-decoration: none;
	}
	.buy:hover {
		background: color-mix(in oklab, var(--accent) 12%, transparent);
	}
	/* OrnamentalBorder's own 2rem padding leaves ~216px of usable width at a
	 * 320px viewport. Claw some of it back rather than let the CTA overflow. */
	@media (max-width: 30rem) {
		.thanks :global(.frame) {
			padding: 1.25rem;
		}
	}
</style>
