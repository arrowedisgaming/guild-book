<script lang="ts">
	import { page } from '$app/state';

	// `page.data` inherits the root layout's return value. If the layout load
	// itself failed, the key is simply absent — hence the optional access
	// rather than a required prop.
	let feedbackUrl = $derived((page.data?.feedbackUrl as string | null | undefined) ?? null);

	let heading = $derived(page.status === 404 ? 'That page is not here' : 'Something went wrong');
</script>

<svelte:head>
	<title>{page.status} — Guild Book</title>
</svelte:head>

<section class="error-page" data-testid="error-page">
	<p class="status" data-testid="error-status">{page.status}</p>
	<h1>{heading}</h1>
	<p class="detail">{page.error?.message ?? 'No further detail is available.'}</p>

	<p class="links">
		<a href="/">Back to Guild Book</a>
		<a href="/characters">My Adventurers</a>
		{#if feedbackUrl}
			<a href={feedbackUrl} target="_blank" rel="noopener noreferrer">Report this</a>
		{/if}
	</p>
</section>

<style>
	.error-page {
		max-width: 34rem;
		margin: 3rem auto;
		text-align: center;
	}
	.status {
		margin: 0;
		font-family: var(--font-display);
		font-size: 3.5rem;
		line-height: 1;
		color: var(--ink-soft);
	}
	.error-page h1 {
		font-family: var(--font-display);
		margin: 0.5rem 0 1rem;
	}
	.detail {
		color: var(--ink-soft);
	}
	.links {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 1.25rem;
		margin-top: 2rem;
	}
</style>
