<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { untrack } from 'svelte';
	import AdventurerPicker from '$lib/components/campaign/AdventurerPicker.svelte';
	import CampaignRoster from '$lib/components/campaign/CampaignRoster.svelte';
	import { createCampaignSessionStore } from '$lib/stores/campaign-session.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	let copied = $state(false);
	let actionMessage = $derived(form && 'message' in form ? form.message : null);

	// ~5s-while-visible dashboard cadence (plan Step 2 / controller amendment
	// 5): reuses the table's store — pause-while-hidden, immediate refresh on
	// focus/reconnect all come for free — purely as a change detector here.
	// This page has no live session UI of its own; `campaignEvents` is one
	// campaign-wide cursor shared with membership/tenure/character events
	// (`db/schema.ts`), so a cursor bump just means "reload this page's data"
	// (`invalidateAll`) — never a session projection to render.
	//
	// Constructed exactly once (review round 2: no throwaway store built
	// before the mount effect swaps in a second one), and only rebuilt if
	// `data.campaign.id` itself changes (SvelteKit reusing this instance
	// across a client-side navigation between two different campaigns) —
	// not on every `data` refresh, including the ones this page's own
	// `invalidateAll()` below triggers.
	let store = $state.raw(untrack(() => createDashboardStoreFor(data)));
	let storeCampaignId = untrack(() => data.campaign.id);
	let lastAppliedCursor = untrack(() => data.cursor);

	$effect(() => {
		if (data.campaign.id !== storeCampaignId) {
			store.stop();
			store = createDashboardStoreFor(data);
			storeCampaignId = data.campaign.id;
			lastAppliedCursor = data.cursor;
		}
		store.start();
		return () => store.stop();
	});

	$effect(() => {
		const cursor = store.snapshot.cursor;
		if (cursor !== lastAppliedCursor) {
			lastAppliedCursor = cursor;
			void invalidateAll();
		}
	});

	function createDashboardStoreFor(pageData: PageData) {
		return createCampaignSessionStore(
			pageData.campaign.id,
			{ cursor: pageData.cursor, events: [], session: null },
			{ intervalMs: 5000 }
		);
	}

	async function copyInvite() {
		if (!data.inviteUrl) return;
		await navigator.clipboard.writeText(data.inviteUrl);
		copied = true;
		setTimeout(() => (copied = false), 1600);
	}

	function confirmAction(event: SubmitEvent, message: string) {
		if (!confirm(message)) event.preventDefault();
	}
</script>

<svelte:head><title>{data.campaign.name} — Guild Book</title></svelte:head>

<article class="campaign">
	<a class="back" href="/campaigns">← Campaigns</a>
	<header>
		<div>
			<span class="role">{data.campaign.role === 'gm' ? 'Game Master' : 'Player'}</span>
			{#if data.campaign.archivedAt}<span class="archived">Archived — read-only</span>{/if}
			<h1>{data.campaign.name}</h1>
			{#if data.campaign.description}<p>{data.campaign.description}</p>{/if}
		</div>
	</header>

	{#if data.joinedWithoutAdventurer}
		<p class="notice" role="status">Joined without an adventurer. Choose one below when you are ready.</p>
	{/if}
	{#if actionMessage}<p class="error" role="alert">{actionMessage}</p>{/if}

	{#if data.campaign.role === 'gm' && data.campaign.archivedAt === null}
		<section class="invite" aria-labelledby="invitation-controls-heading">
			<div>
				<p class="eyebrow">Bring players into the guild</p>
				<h2 id="invitation-controls-heading">Invitation controls</h2>
			</div>
			{#if data.inviteUrl}
				<label for="invite-link">Invite link</label>
				<div class="invite-link">
					<input id="invite-link" readonly value={data.inviteUrl} />
					<button type="button" onclick={copyInvite}>{copied ? 'Copied!' : 'Copy link'}</button>
				</div>
			{:else}
				<p class="closed">New members cannot join while this invitation is closed.</p>
			{/if}
			<div class="invite-actions">
				<form method="POST" action={data.campaign.joinOpen ? '?/closeInvite' : '?/openInvite'}>
					<button type="submit">
						{data.campaign.joinOpen ? 'Close invitation' : 'Reopen invitation'}
					</button>
				</form>
				<form
					method="POST"
					action="?/rotateInvite"
					onsubmit={(event) => confirmAction(event, 'Rotate this invitation? The current link will stop working.')}
				>
					<button type="submit">Rotate invitation</button>
				</form>
			</div>
		</section>
	{/if}

	<div class="grid">
		<CampaignRoster
			members={data.members}
			tenures={data.tenures}
			role={data.campaign.role}
			readOnly={data.campaign.archivedAt !== null}
		/>

		<section class="guild-roster" aria-labelledby="guild-roster-heading">
			<div class="roster-title">
				<div>
					<p class="eyebrow">Shared document</p>
					<h2 id="guild-roster-heading">Guild roster</h2>
				</div>
				<strong>{data.campaign.roster.document.fame} fame</strong>
			</div>
			{#if data.campaign.roster.document.sigilDescription}
				<p>{data.campaign.roster.document.sigilDescription}</p>
			{/if}
			<dl>
				<div>
					<dt>Guild terms</dt>
					<dd>{data.campaign.roster.document.terms.length}</dd>
				</div>
				<div>
					<dt>Open contracts</dt>
					<dd>{data.campaign.roster.document.contracts.filter((contract) => contract.status === 'open').length}</dd>
				</div>
				<div>
					<dt>Recorded deeds</dt>
					<dd>{data.campaign.roster.document.deeds.length}</dd>
				</div>
			</dl>
			<p class="future">Roster editing and the live campaign table arrive in the next increment.</p>
		</section>
	</div>

	{#if data.campaign.archivedAt === null && data.campaign.role === 'player'}
		<AdventurerPicker
			adventurers={data.eligibleAdventurers}
			hasActiveTenure={data.activePlayerTenureId !== null}
		/>
		<form
			class="danger-action"
			method="POST"
			action="?/leave"
			onsubmit={(event) => confirmAction(event, 'Leave this campaign? Your active tenure will end and you will lose access to its history.')}
		>
			<button type="submit">Leave campaign</button>
		</form>
	{:else if data.campaign.archivedAt === null}
		<form
			class="danger-action"
			method="POST"
			action="?/archive"
			onsubmit={(event) => confirmAction(event, 'Archive this campaign? It will become read-only for current participants.')}
		>
			<button type="submit">Archive campaign</button>
		</form>
	{/if}
</article>

<style>
	.campaign {
		max-width: 62rem;
		margin: 0 auto;
	}
	.back {
		font-family: var(--font-subhead);
		font-size: 0.9rem;
	}
	header {
		margin: 1.5rem 0;
		padding-bottom: 1.25rem;
		border-bottom: 2px solid color-mix(in oklab, var(--ink) 60%, transparent);
	}
	h1,
	header p {
		margin: 0;
	}
	header p {
		max-width: 46rem;
		margin-top: 0.35rem;
		color: var(--ink-soft);
	}
	.role,
	.eyebrow {
		font-family: var(--font-subhead);
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--ink-soft);
	}
	.archived {
		display: inline-block;
		margin-left: 0.55rem;
		padding-left: 0.55rem;
		border-left: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		font-family: var(--font-subhead);
		font-size: 0.72rem;
		color: var(--ink-soft);
	}
	.notice,
	.error {
		padding: 0.8rem 1rem;
		border-left: 3px solid var(--accent);
		background: color-mix(in oklab, var(--accent) 7%, transparent);
	}
	.error {
		border-color: var(--danger, var(--accent));
	}
	.invite {
		margin-bottom: 1rem;
		padding: 1.25rem;
		border: 1px solid color-mix(in oklab, var(--accent) 35%, transparent);
	}
	.invite h2,
	.invite .eyebrow {
		margin: 0;
	}
	.invite label {
		display: block;
		margin-top: 0.9rem;
		font-family: var(--font-subhead);
		font-size: 0.82rem;
	}
	.invite-link {
		display: flex;
		gap: 0.45rem;
	}
	.invite-link input {
		flex: 1;
		min-width: 0;
		padding: 0.55rem;
		border: 1px solid color-mix(in oklab, var(--ink) 22%, transparent);
		background: var(--parchment);
		color: var(--ink-soft);
	}
	.invite button,
	.danger-action button {
		padding: 0.5rem 0.7rem;
		border: 1px solid color-mix(in oklab, var(--ink) 30%, transparent);
		background: var(--parchment);
		color: var(--accent);
		font-family: var(--font-subhead);
		cursor: pointer;
	}
	.invite-actions {
		display: flex;
		gap: 0.55rem;
		margin-top: 0.75rem;
	}
	.closed,
	.future {
		color: var(--ink-soft);
	}
	.grid {
		display: grid;
		grid-template-columns: minmax(0, 3fr) minmax(15rem, 2fr);
		gap: 1rem;
		margin-bottom: 1rem;
	}
	.guild-roster {
		padding: 1.25rem;
		border: 1px solid color-mix(in oklab, var(--ink) 18%, transparent);
	}
	.roster-title {
		display: flex;
		align-items: start;
		justify-content: space-between;
		gap: 1rem;
	}
	.roster-title h2,
	.roster-title p {
		margin: 0;
	}
	dl > div {
		display: flex;
		justify-content: space-between;
		padding: 0.35rem 0;
		border-bottom: 1px solid color-mix(in oklab, var(--ink) 10%, transparent);
	}
	dt,
	dd {
		margin: 0;
	}
	.future {
		font-size: 0.82rem;
	}
	.danger-action {
		margin-top: 1rem;
		text-align: right;
	}
	.danger-action button {
		border-color: color-mix(in oklab, var(--accent) 45%, transparent);
	}
	@media (max-width: 44rem) {
		.grid {
			grid-template-columns: 1fr;
		}
		.invite-link {
			flex-direction: column;
		}
	}
</style>
