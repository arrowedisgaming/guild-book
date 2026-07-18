<script lang="ts">
	import { page } from '$app/state';
</script>

<svelte:head><title>Campaign Invitation Unavailable — Guild Book</title></svelte:head>

<section class="invitation-error">
	<p class="eyebrow">Invitation unavailable</p>
	<h1>The way is closed</h1>
	<p>
		{page.status === 404
			? 'This invitation is no longer available.'
			: 'The campaign invitation could not be loaded.'}
	</p>
	<a href="/campaigns">Return to campaigns</a>
</section>

<style>
	.invitation-error {
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
</style>
