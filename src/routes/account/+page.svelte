<script lang="ts">
	import { signIn } from '@auth/sveltekit/client';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const providerName = (id: string) => (id === 'google' ? 'Google' : 'Discord');
</script>

<svelte:head>
	<title>Account — Guild Book</title>
</svelte:head>

<section class="account">
	<header>
		<p class="eyebrow">Guild Book identity</p>
		<h1>Account</h1>
		<p class="lede">
			Link both providers so either one can open the same saved adventurers on any device.
		</p>
	</header>

	<div class="profile">
		<div>
			<span>Name</span>
			<strong>{data.user.name ?? 'Adventurer'}</strong>
		</div>
		<div>
			<span>Email</span>
			<strong>{data.user.email ?? 'Not provided'}</strong>
		</div>
	</div>

	<div class="providers">
		{#each data.providers as provider}
			<article class="provider">
				<div>
					<h2>{providerName(provider.id)}</h2>
					<p>{provider.linked ? 'Linked to this account' : 'Not linked'}</p>
				</div>
				{#if provider.linked}
					<span class="status">Linked</span>
				{:else}
					<button
						type="button"
						onclick={() => signIn(provider.id, { redirectTo: '/account' })}
					>
						Link {providerName(provider.id)}
					</button>
				{/if}
			</article>
		{/each}
	</div>

	<aside>
		<h2>Anonymous tools stay anonymous</h2>
		<p>
			You never need an account to build an adventurer or denizen and download its PDF or
			Markdown. Signing in is only required to save adventurers to Guild Book.
		</p>
	</aside>
</section>

<style>
	.account {
		max-width: 42rem;
		margin: 0 auto;
	}
	header {
		margin-bottom: 1.75rem;
	}
	.eyebrow {
		margin: 0 0 0.25rem;
		color: var(--accent);
		font-family: var(--font-subhead);
		font-size: 0.75rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}
	h1,
	h2,
	p {
		margin-top: 0;
	}
	.lede {
		max-width: 36rem;
		color: var(--ink-soft);
	}
	.profile {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 1rem;
		margin-bottom: 1.5rem;
	}
	.profile div,
	.provider,
	aside {
		border: 1px solid color-mix(in oklab, var(--ink) 20%, transparent);
		border-radius: 4px;
		background: color-mix(in oklab, var(--parchment) 94%, white);
	}
	.profile div {
		display: grid;
		gap: 0.25rem;
		padding: 1rem;
	}
	.profile span,
	.provider p {
		color: var(--ink-soft);
		font-size: 0.8rem;
	}
	.providers {
		display: grid;
		gap: 0.75rem;
	}
	.provider {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 1rem;
	}
	.provider h2,
	.provider p {
		margin-bottom: 0;
	}
	.provider h2,
	aside h2 {
		font-size: 1rem;
	}
	button {
		padding: 0.5rem 0.8rem;
		border: 1px solid var(--accent);
		border-radius: 4px;
		background: var(--accent);
		color: var(--parchment);
		font-family: var(--font-subhead);
		cursor: pointer;
	}
	.status {
		color: var(--accent);
		font-family: var(--font-subhead);
		font-size: 0.8rem;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}
	aside {
		margin-top: 1.5rem;
		padding: 1rem;
	}
	aside p {
		margin-bottom: 0;
		color: var(--ink-soft);
		font-size: 0.9rem;
	}
	@media (max-width: 36rem) {
		.profile {
			grid-template-columns: 1fr;
		}
		.provider {
			align-items: flex-start;
			flex-direction: column;
		}
	}
</style>
