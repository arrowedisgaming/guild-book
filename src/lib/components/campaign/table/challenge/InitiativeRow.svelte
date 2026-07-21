<script lang="ts">
	/**
	 * One rendered Initiative turn slot. Presentation-only — every field it
	 * reads (`revealed`/`turnKind`/`tied`/`card`) is already computed
	 * server-side by `projection.ts`'s `projectChallengeForActor`; this
	 * component never decides legality or resolves a tie itself (O3: a tie is
	 * SURFACED for the table to adjudicate, never auto-resolved here — there
	 * is deliberately no "who goes first" control on a tied entry).
	 *
	 * Keyed by the caller on `entry.index`, never `entry.tenureId`/
	 * `entry.card`/a zone id (O4 — the Fool's extra turn is a shallow clone of
	 * the entry it follows and shares every one of those fields with it; only
	 * `index` stays unique per rendered slot). A face-down entry's
	 * `aria-label` names the owner and seat POSITION, never a card identity.
	 *
	 * `roster` (review round: previously rendered `Player <uuid>` to screen
	 * readers) supplies real character names — sourced from
	 * `loadActiveChallengeRoster`, non-secret campaign membership — so a seat
	 * label reads as a name, never a raw user/tenure id. Still carries no card
	 * identity; only WHO occupies the seat.
	 */
	import { renderableCard } from '$lib/stores/campaign-session.svelte';
	import TarotCard from '$lib/components/tarot/TarotCard.svelte';
	import type { ChallengeInitiativeSlotView } from '$lib/engine/session/procedures/challenge/projection';
	import type { ActiveChallengeTenureView } from '$lib/server/campaign/page-data';

	let {
		entry,
		tenureOwners,
		roster,
		viewerUserId,
		isActive
	}: {
		entry: ChallengeInitiativeSlotView;
		tenureOwners: Record<string, string>;
		roster: ActiveChallengeTenureView[];
		viewerUserId: string;
		isActive: boolean;
	} = $props();

	const ownerUserId = $derived(tenureOwners[entry.tenureId]);
	const character = $derived(roster.find((r) => r.tenureId === entry.tenureId));
	const seatLabel = $derived(
		ownerUserId
			? ownerUserId === viewerUserId
				? 'You'
				: (character?.characterName ?? 'Another adventurer')
			: `Enemy (${entry.tenureId})`
	);
	const rendered = $derived(renderableCard(entry.card));
	const faceDownLabel = $derived(`${seatLabel} — Initiative, seat ${entry.index + 1}, face down`);
</script>

<li
	class="initiative-row"
	class:active={isActive}
	class:tied={entry.tied}
	data-testid="initiative-row"
	data-active={isActive}
	data-tied={entry.tied}
>
	<div class="card-slot" aria-label={entry.revealed ? undefined : faceDownLabel} role={entry.revealed ? undefined : 'img'}>
		<TarotCard card={rendered.card} faceDown={rendered.faceDown} size="sm" />
	</div>
	<div class="meta">
		<span class="seat" data-testid="initiative-seat-label">{seatLabel}</span>
		{#if entry.turnKind === 'fool-extra'}
			<span class="badge fool" data-testid="initiative-fool-extra">Fool's extra turn</span>
		{/if}
		{#if entry.tied}
			<span class="badge tie" data-testid="initiative-tied-badge">Tied — table decides order</span>
		{/if}
		{#if isActive}
			<span class="badge active" data-testid="initiative-active-badge">Active turn</span>
		{/if}
	</div>
</li>

<style>
	.initiative-row {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.4rem 0.5rem;
		border: 1px solid color-mix(in oklab, var(--ink) 14%, transparent);
	}
	.initiative-row.active {
		border-color: var(--accent);
		background: color-mix(in oklab, var(--accent) 10%, transparent);
	}
	.initiative-row.tied {
		border-style: dashed;
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.8rem;
	}
	.seat {
		font-family: var(--font-subhead);
	}
	.badge {
		padding: 0.1rem 0.4rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 999px;
		font-size: 0.7rem;
		color: var(--ink-soft);
	}
	.badge.tie {
		border-color: color-mix(in oklab, #b3261e 55%, transparent);
		color: #b3261e;
	}
	.badge.active {
		border-color: var(--accent);
		color: var(--accent);
	}
</style>
