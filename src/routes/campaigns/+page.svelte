<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>Campaigns — Guild Book</title></svelte:head>

<section class="campaigns">
	<header>
		<div>
			<p class="eyebrow">Guild ledger</p>
			<h1>Campaigns</h1>
		</div>
		<a class="new" href="/campaigns/new">New campaign</a>
	</header>

	{#if data.campaigns.length === 0}
		<div class="empty">
			<h2>No campaigns yet</h2>
			<p>Create a guild as Game Master, or join one through an invitation.</p>
		</div>
	{:else}
		<ul>
			{#each data.campaigns as campaign (campaign.id)}
				<li>
					<a href="/campaigns/{campaign.id}">
						<span class="role">
							{campaign.role === 'gm' ? 'Game Master' : 'Player'}{campaign.archivedAt ? ' · Archived' : ''}
						</span>
						<strong>{campaign.name}</strong>
						{#if campaign.description}<span>{campaign.description}</span>{/if}
					</a>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.campaigns {
		max-width: 52rem;
		margin: 0 auto;
	}
	header {
		display: flex;
		align-items: end;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1.5rem;
	}
	h1,
	.eyebrow {
		margin: 0;
	}
	.eyebrow,
	.role {
		font-family: var(--font-subhead);
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--ink-soft);
	}
	.new {
		padding: 0.55rem 0.8rem;
		border: 1px solid var(--accent);
		font-family: var(--font-subhead);
		text-decoration: none;
	}
	ul {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
		gap: 0.9rem;
		list-style: none;
		padding: 0;
	}
	li a {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-height: 8rem;
		padding: 1rem;
		border: 1px solid color-mix(in oklab, var(--ink) 18%, transparent);
		color: var(--ink);
		text-decoration: none;
	}
	li a:hover {
		border-color: var(--accent);
	}
	li strong {
		font-family: var(--font-heading);
		font-size: 1.25rem;
	}
	li span:last-child {
		color: var(--ink-soft);
	}
	.empty {
		padding: 2rem;
		border: 1px dashed color-mix(in oklab, var(--ink) 25%, transparent);
		text-align: center;
	}
</style>
