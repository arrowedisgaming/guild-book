<script lang="ts">
	/**
	 * The public event log. `WireSessionEvent.publicPayload` is already
	 * scrubbed server-side (`sanitize.ts`'s `toWireEvent` / the engine's
	 * `buildMoveEvent`) — a hidden-destination move's public payload never
	 * carries `cardIds`, only counts/zone ids — so this renders it generically
	 * without needing per-kind knowledge of what might be secret.
	 */
	import type { WireSessionEventLike } from '$lib/stores/campaign-session.svelte';

	let { events }: { events: WireSessionEventLike[] } = $props();

	function summarize(event: WireSessionEventLike): string {
		const payload = event.publicPayload;
		const parts = [humanizeKind(event.kind)];
		if (isRecord(payload)) {
			if (typeof payload.count === 'number') parts.push(`(${payload.count})`);
			if (typeof payload.destinationZoneId === 'string') parts.push(`→ ${payload.destinationZoneId}`);
			else if (typeof payload.zoneId === 'string') parts.push(`@ ${payload.zoneId}`);
			// `reveal`'s public payload deliberately carries the card id — per
			// `card-commands.ts`'s `handleReveal`, disclosure is the whole point
			// of the command, unlike every other move/draw event, whose public
			// payload never carries an identity for a hidden destination. This is
			// therefore the one event kind this log may show a card id for.
			if (event.kind === 'card-revealed' && typeof payload.cardId === 'string') {
				parts.push(`— ${payload.cardId}`);
			}
		}
		return parts.join(' ');
	}

	function humanizeKind(kind: string): string {
		return kind.replace(/-/g, ' ');
	}

	function isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === 'object' && value !== null;
	}
</script>

<section class="event-log" data-testid="event-log" aria-label="Table log">
	<h2>Table log</h2>
	{#if events.length === 0}
		<p class="empty">No activity yet.</p>
	{:else}
		<ol>
			{#each events as event (event.id)}
				<li>{summarize(event)}</li>
			{/each}
		</ol>
	{/if}
</section>

<style>
	.event-log {
		padding: 1rem;
		border: 1px solid color-mix(in oklab, var(--ink) 18%, transparent);
	}
	h2 {
		margin: 0 0 0.5rem;
		font-size: 1rem;
	}
	.empty {
		margin: 0;
		color: var(--ink-soft);
		font-size: 0.85rem;
	}
	ol {
		margin: 0;
		padding-left: 1.1rem;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		font-size: 0.85rem;
		color: var(--ink-soft);
		text-transform: capitalize;
	}
</style>
