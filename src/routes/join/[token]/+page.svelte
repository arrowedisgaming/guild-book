<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>Campaign Invitation — Guild Book</title></svelte:head>

<section class="invitation">
	<p class="eyebrow">You have been invited</p>
	<h1>Join {data.invitation.name}</h1>
	<p>
		Joining adds you as an observer. You can choose an eligible adventurer from the campaign page.
	</p>
	<form method="POST">
		<button type="submit">Join campaign</button>
	</form>
</section>

<style>
	.invitation {
		max-width: 34rem;
		margin: 3rem auto;
		padding: 2rem;
		border: 1px solid color-mix(in oklab, var(--ink) 22%, transparent);
		text-align: center;
	}
	.eyebrow {
		margin: 0;
		font-family: var(--font-subhead);
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--ink-soft);
	}
	h1 {
		margin: 0.35rem 0 0.75rem;
	}
	button {
		margin-top: 0.75rem;
		padding: 0.65rem 1rem;
		border: 1px solid var(--accent);
		background: var(--accent);
		color: var(--parchment);
		font-family: var(--font-subhead);
		cursor: pointer;
	}
</style>
