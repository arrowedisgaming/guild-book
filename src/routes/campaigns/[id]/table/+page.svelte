<script lang="ts">
	import { untrack } from 'svelte';
	import TableShell from '$lib/components/campaign/table/TableShell.svelte';
	import { createCampaignSessionStore } from '$lib/stores/campaign-session.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Constructed exactly once (review round 2: no throwaway store built
	// before the mount effect swaps in a second one). Reactive on
	// `data.campaignId`, not just captured once: SvelteKit can reuse this
	// same +page.svelte instance across a client-side navigation between two
	// different campaigns' table routes, so the store is torn down and
	// rebuilt for the new campaign rather than silently continuing to poll
	// the old one — but only then, not on every unrelated `data` refresh.
	let store = $state.raw(untrack(() => createStoreFor(data)));
	let storeCampaignId = untrack(() => data.campaignId);

	$effect(() => {
		if (data.campaignId !== storeCampaignId) {
			store.stop();
			store = createStoreFor(data);
			storeCampaignId = data.campaignId;
		}
		store.start();
		return () => store.stop();
	});

	function createStoreFor(pageData: PageData) {
		return createCampaignSessionStore(pageData.campaignId, pageData.initial, { intervalMs: 1000 });
	}

	const session = $derived(store.session);
</script>

<svelte:head><title>{data.campaignName} — Table — Guild Book</title></svelte:head>

<article class="table-page">
	<a class="back" href="/campaigns/{data.campaignId}">← {data.campaignName}</a>

	{#if store.error}
		<p class="sync-error" role="status">{store.error}</p>
	{/if}

	{#if session}
		<TableShell
			role={data.role}
			userId={data.userId}
			{session}
			events={store.events}
			onSendCommand={store.sendCommand}
		/>
	{:else if data.role === 'gm'}
		<section class="no-session">
			<h1>{data.campaignName} — Table</h1>
			<p>No session is currently open.</p>
			<form method="POST" action="?/start">
				<button type="submit">Start session</button>
			</form>
		</section>
	{:else}
		<section class="no-session">
			<h1>{data.campaignName} — Table</h1>
			<p>Waiting for the GM to start a session.</p>
		</section>
	{/if}
</article>

<style>
	.table-page {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		padding: 1.5rem;
	}
	.back {
		align-self: flex-start;
		color: var(--ink-soft);
		text-decoration: none;
		font-size: 0.9rem;
	}
	.sync-error {
		margin: 0;
		padding: 0.5rem 0.75rem;
		border: 1px solid color-mix(in oklab, #b3261e 60%, transparent);
		color: #b3261e;
		font-size: 0.85rem;
	}
	.no-session {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		align-items: flex-start;
	}
	.no-session button {
		border: 1px solid color-mix(in oklab, var(--accent) 55%, transparent);
		background: none;
		padding: 0.5rem 0.9rem;
		font-family: var(--font-subhead);
		cursor: pointer;
	}
</style>
