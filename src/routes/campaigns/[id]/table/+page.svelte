<script lang="ts">
	import { untrack } from 'svelte';
	import TableShell from '$lib/components/campaign/table/TableShell.svelte';
	import { createCampaignSessionStore } from '$lib/stores/campaign-session.svelte';
	import type { ActionData, PageData } from './$types';

	// `form` carries the `?/start` action's `fail()` payload. The form is a
	// plain (unenhanced) POST, so a rejected start re-renders this page — with
	// nothing to show for it until this was rendered, which is exactly what
	// made a refused start look like a dead button.
	let { data, form }: { data: PageData; form: ActionData } = $props();

	// Constructed exactly once (review round 2: no throwaway store built
	// before the mount effect swaps in a second one). Reactive on
	// `data.campaignId` AND `data.userId`, not just captured once: SvelteKit
	// can reuse this same +page.svelte instance across a client-side
	// navigation between two different campaigns' table routes, and the
	// signed-in user can change under the same mounted page (login switch in
	// another tab, then a `data` refresh here). Either way the store is torn
	// down and rebuilt so it never keeps polling — or rendering — the old
	// identity's actor-scoped projection; but only then, not on every
	// unrelated `data` refresh.
	let store = $state.raw(untrack(() => createStoreFor(data)));
	let storeCampaignId = untrack(() => data.campaignId);
	let storeUserId = untrack(() => data.userId);

	$effect(() => {
		if (data.campaignId !== storeCampaignId || data.userId !== storeUserId) {
			store.stop();
			store = createStoreFor(data);
			storeCampaignId = data.campaignId;
			storeUserId = data.userId;
		}
		store.start();
		return () => store.stop();
	});

	function createStoreFor(pageData: PageData) {
		return createCampaignSessionStore(pageData.campaignId, pageData.initial, {
			intervalMs: 1000,
			recipientUserId: pageData.userId
		});
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
			challengeRoster={data.challengeRoster}
			enemyThreatOptions={data.enemyThreatOptions}
			onSendCommand={store.sendCommand}
			onSendChallengeCommand={store.sendChallengeCommand}
			onSendGuidedTestCommand={store.sendGuidedTestCommand}
			onSendCampCommand={store.sendCampCommand}
			onSendFiniteCommand={store.sendFiniteCommand}
			onSendCorrectionCommand={store.sendCorrectionCommand}
			procedureTitles={data.procedureTitles}
			onSendLifecycleAction={store.sendLifecycleAction}
		/>
	{:else if data.sessionUnavailable}
		<section class="no-session">
			<h1>{data.campaignName} — Table</h1>
			<p class="sync-error" role="status">
				This campaign has an open session, but it could not be loaded — so it cannot be shown, and a
				new session cannot be started while it holds the campaign's open-session slot. This does not
				resolve on its own; the session has to be ended before play can continue. The server log
				records the specific reason.
			</p>
		</section>
	{:else if data.role === 'gm'}
		<section class="no-session">
			<h1>{data.campaignName} — Table</h1>
			<p>No session is currently open.</p>
			{#if form?.message}
				<p class="sync-error" role="alert">{form.message}</p>
			{/if}
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
