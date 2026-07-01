<script lang="ts">
	let { data } = $props();
</script>

<section class="hero">
	<h1>Guild Book</h1>
	<p class="tagline">
		Awaken, querent. Assemble an adventurer for <em>His Majesty the Worm</em>, consult the rules, and
		let the cards decide your fate.
	</p>

	<div class="actions">
		<a class="cta" href="/create/hmtw/identity">Create an adventurer</a>
		<a class="cta cta--ghost" href="/rules">Browse the rules</a>
		<a class="cta cta--ghost" href="/deck">Draw the deck</a>
	</div>

	<p class="scaffold-note">
		Scaffold v{data.appVersion} — the creation wizard, rules reference, and tarot deck are being
		built out phase by phase.
	</p>
</section>

<style>
	.hero {
		max-width: 44rem;
		padding: 2rem 0 4rem;
	}
	h1 {
		font-size: clamp(2.75rem, 8vw, 4.5rem);
		margin: 0 0 0.5rem;
	}
	.tagline {
		font-size: 1.2rem;
		color: var(--ink-soft);
		margin: 0 0 2rem;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		margin-bottom: 2.5rem;
	}
	.cta {
		display: inline-block;
		padding: 0.6rem 1.1rem;
		border: 1px solid var(--accent);
		border-radius: 2px;
		background: var(--accent);
		color: var(--parchment);
		font-family: var(--font-subhead);
		text-decoration: none;
	}
	.cta--ghost {
		background: transparent;
		color: var(--accent);
	}
	.scaffold-note {
		font-size: 0.8rem;
		color: var(--ink-soft);
		font-style: italic;
	}
</style>
