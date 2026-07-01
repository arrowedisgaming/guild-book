<script lang="ts">
	import '../app.css';
	import type { Snippet } from 'svelte';
	import { signOut } from '@auth/sveltekit/client';
	import type { LayoutData } from './$types';

	let { children, data }: { children: Snippet; data: LayoutData } = $props();
</script>

<div class="site">
	<header class="site-header">
		<a class="brand" href="/">Guild Book</a>
		<nav class="site-nav">
			<a href="/create/hmtw/identity">Create</a>
			<a href="/rules">Rules</a>
			<a href="/deck">Deck</a>
			{#if data.user}
				<a href="/characters">My Adventurers</a>
				<button type="button" class="linkish" onclick={() => signOut({ redirectTo: '/' })}>
					Sign out
				</button>
			{:else}
				<a href="/login">Sign in</a>
			{/if}
		</nav>
	</header>

	<main class="site-main">
		{@render children()}
	</main>

	<footer class="site-footer">
		<p>
			An <em>Adherent of His Majesty the Worm</em>. His Majesty the Worm is copyright Joshua
			McCrowell. Guild Book is an independent production by Arrowed and is not affiliated with
			Joshua McCrowell or Exalted Funeral.
		</p>
		<p><a href="/licensing">Licensing &amp; credits</a></p>
	</footer>
</div>

<style>
	.site {
		display: flex;
		flex-direction: column;
		min-height: 100vh;
		max-width: 72rem;
		margin: 0 auto;
		padding: 0 1.25rem;
	}
	.site-header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
		padding: 1.25rem 0;
		border-bottom: 1px solid color-mix(in oklab, var(--ink) 18%, transparent);
	}
	.brand {
		font-family: var(--font-display);
		font-size: 1.75rem;
		color: var(--ink);
		text-decoration: none;
	}
	.site-nav {
		display: flex;
		align-items: baseline;
		gap: 1.25rem;
		font-family: var(--font-subhead);
	}
	.linkish {
		border: none;
		background: none;
		padding: 0;
		color: var(--accent);
		font: inherit;
		cursor: pointer;
	}
	.site-main {
		flex: 1;
		padding: 2rem 0;
	}
	.site-footer {
		padding: 1.5rem 0;
		border-top: 1px solid color-mix(in oklab, var(--ink) 18%, transparent);
		font-size: 0.8rem;
		color: var(--ink-soft);
	}
	.site-footer p {
		margin: 0 0 0.5rem;
	}
</style>
