<script lang="ts">
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>Completed sessions — Guild Book</title></svelte:head>

<main class="sessions-page">
	<h1>Completed sessions</h1>
	{#if data.sessions.length === 0}
		<p data-testid="no-sessions">No sessions have been completed yet.</p>
	{:else}
		<ol class="sessions" data-testid="session-list">
			{#each data.sessions as session (session.sessionId)}
				<li>
					<a href={`/campaigns/${data.campaignId}/sessions/${session.sessionId}`} data-testid={`session-link-${session.sequence}`}>
						Session {session.sequence}
					</a>
					<span class="ended">ended {new Date(session.endedAt).toLocaleString()}</span>
				</li>
			{/each}
		</ol>
	{/if}
	<a href={`/campaigns/${data.campaignId}`}>Back to the campaign</a>
</main>

<style>
	.sessions-page {
		max-width: 42rem;
		margin: 0 auto;
		padding: 1.5rem 1rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.sessions {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.ended {
		margin-left: 0.6rem;
		color: var(--ink-soft);
		font-size: 0.9rem;
	}
</style>
