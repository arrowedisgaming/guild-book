<script lang="ts">
	import { onMount } from 'svelte';

	let { feedbackUrl = null }: { feedbackUrl?: string | null } = $props();

	const STORAGE_KEY = 'gb-alpha-banner-dismissed';

	/**
	 * Rendered VISIBLE during SSR on purpose. A tester who already dismissed it
	 * sees a brief flash before `onMount` reads sessionStorage — that is the
	 * safe direction to err. Rendering hidden until JS confirms would instead
	 * flash *no warning* at every user on every page.
	 */
	let dismissed = $state(false);

	onMount(() => {
		try {
			if (sessionStorage.getItem(STORAGE_KEY) === '1') dismissed = true;
		} catch {
			// Private mode or blocked storage: stay visible rather than throw.
		}
	});

	function dismiss() {
		dismissed = true;
		try {
			sessionStorage.setItem(STORAGE_KEY, '1');
		} catch {
			// Dismissal simply does not persist. Never throw from a click handler.
		}
	}
</script>

{#if !dismissed}
	<!-- Deliberately NO role="alert" and NO aria-live: either would interrupt
	     screen reader users on every navigation for the whole beta. Being first
	     in the DOM is what makes assistive technology reach it early. -->
	<div class="alpha-banner" data-testid="alpha-banner">
		<p>
			<strong>Alpha.</strong> Guild Book is early test software — expect rough edges, and
			<strong>your data may be lost</strong>.
			<a href="/characters">Export your adventurers</a> to keep your own copy.
			{#if feedbackUrl}
				<a href={feedbackUrl} target="_blank" rel="noopener noreferrer">Send feedback</a>
			{/if}
		</p>
		<button type="button" aria-label="Dismiss alpha warning" onclick={dismiss}>×</button>
	</div>
{/if}

<style>
	.alpha-banner {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
		/* Wrapping, not overflow: the nav above already documents why 320px and
		 * 200% zoom are hard constraints in this layout. */
		flex-wrap: wrap;
		margin: 0 -1.25rem;
		padding: 0.6rem 1.25rem;
		background: var(--alert);
		color: var(--alert-ink);
		border-bottom: 1px solid color-mix(in oklab, var(--alert-ink) 25%, transparent);
		font-size: 0.85rem;
		line-height: 1.45;
	}
	.alpha-banner p {
		margin: 0;
		min-width: 0;
		flex: 1 1 16rem;
	}
	.alpha-banner a {
		color: inherit;
		text-decoration: underline;
	}
	.alpha-banner button {
		flex: none;
		border: none;
		background: none;
		padding: 0 0.25rem;
		color: inherit;
		font: inherit;
		font-size: 1.1rem;
		line-height: 1;
		cursor: pointer;
	}
</style>
