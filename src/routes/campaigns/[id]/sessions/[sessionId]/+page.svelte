<script lang="ts">
	/**
	 * The ordered public log and final table of one completed session. Every
	 * datum here came through the sanitized history loader — the page renders
	 * what it is given and nothing else.
	 */
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();

	interface FinalZone {
		id: string;
		kind: string;
		cards: Array<{ hidden: boolean; label?: string }>;
	}
	const finalState = $derived(
		(data.history.finalPublicState ?? null) as {
			publicZones?: FinalZone[];
			playerDiscardTop?: { hidden: boolean; label?: string } | null;
			majorDiscardTop?: { hidden: boolean; label?: string } | null;
		} | null
	);

	function describe(event: { kind: string; publicPayload: unknown }): string {
		const payload = (event.publicPayload ?? {}) as Record<string, unknown>;
		if (event.kind === 'correction-applied') {
			return `Correction (${String(payload.correctionKind ?? '')}): ${String(payload.reason ?? '')}`;
		}
		return event.kind.replaceAll('-', ' ');
	}
</script>

<svelte:head><title>Session {data.history.sequence} — Guild Book</title></svelte:head>

<main class="history-page">
	<h1>Session {data.history.sequence}</h1>
	<p class="meta" data-testid="history-meta">
		Ended {new Date(data.history.endedAt).toLocaleString()}
		{#if data.history.publicHistoryChecksum}
			<span class="checksum" title="Corruption detection only — not a signature">checksum {data.history.publicHistoryChecksum.slice(0, 12)}…</span>
		{/if}
	</p>

	{#if finalState?.publicZones?.length}
		<section aria-label="Final table">
			<h2>Final table</h2>
			{#each finalState.publicZones.filter((zone) => zone.cards.length > 0) as zone (zone.id)}
				<p data-testid={`final-zone-${zone.id}`}>
					<strong>{zone.kind}</strong>: {zone.cards.map((card) => (card.hidden ? 'Face-down card' : (card.label ?? ''))).join(', ')}
				</p>
			{/each}
		</section>
	{/if}

	<section aria-label="Public log">
		<h2>Public log</h2>
		<ol class="log" data-testid="history-log">
			{#each data.history.publicEvents as event (event.id)}
				<li data-kind={event.kind}>{describe(event)}</li>
			{/each}
		</ol>
	</section>

	<a href={`/campaigns/${data.campaignId}/sessions`}>All completed sessions</a>
</main>

<style>
	.history-page {
		max-width: 42rem;
		margin: 0 auto;
		padding: 1.5rem 1rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.meta,
	.checksum {
		color: var(--ink-soft);
		font-size: 0.9rem;
	}
	.checksum {
		margin-left: 0.6rem;
		font-family: var(--font-mono, monospace);
	}
	.log {
		margin: 0;
		padding-left: 1.4rem;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.9rem;
	}
	h2 {
		font-size: 1.05rem;
		margin: 0;
	}
</style>
