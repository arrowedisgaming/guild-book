<script lang="ts">
	/**
	 * Deck/phase status and the GM's structural table controls. Generic
	 * actions are gated by `canDeal`/`canEndRound` — both computed by the
	 * caller from the projection's own `legalCommands`, never guessed here.
	 */
	import { renderableCard } from '$lib/stores/campaign-session.svelte';
	import TarotCard from '$lib/components/tarot/TarotCard.svelte';
	import type { SessionPublicProjection, SessionStatus } from '$lib/types/session';

	let {
		publicProjection,
		role,
		canDeal,
		dealDisabled = false,
		canEndRound,
		onDeal,
		onEndRound,
		sessionStatus,
		onFreeze,
		onRecover,
		onEndSession
	}: {
		publicProjection: SessionPublicProjection;
		role: 'gm' | 'player';
		canDeal: boolean;
		/** True when `canDeal` is legal in principle but there is currently no
		 * eligible destination hand (e.g. no other members connected yet) — the
		 * button stays visible but disabled with a hint, rather than either
		 * silently no-oping (the bug this fixes) or disappearing entirely. */
		dealDisabled?: boolean;
		canEndRound: boolean;
		onDeal: () => void | Promise<void>;
		onEndRound: () => void | Promise<void>;
		/** Only 'active' | 'frozen' ever reach this component — `TableShell`
		 * only renders it while a session is open. */
		sessionStatus: SessionStatus;
		onFreeze: () => void | Promise<void>;
		onRecover: () => void | Promise<void>;
		onEndSession: () => void | Promise<void>;
	} = $props();

	// Two-click confirm, not a browser `confirm()` dialog (those block the
	// E2E automation harness) — clicking "End session" reveals a confirm row
	// instead of firing the PATCH immediately, since it permanently purges
	// every player's private state.
	let confirmingEnd = $state(false);

	async function confirmEndSession(): Promise<void> {
		confirmingEnd = false;
		await onEndSession();
	}

	const majorDiscard = $derived(renderableCard(publicProjection.majorDiscardTop));
	const playerDiscard = $derived(renderableCard(publicProjection.playerDiscardTop));
</script>

<aside class="phase-rail" data-testid="phase-rail" aria-label="Phase and deck status">
	<p class="phase" data-testid="session-phase">Phase: {publicProjection.phase}</p>
	{#if publicProjection.procedure}
		<p class="procedure">
			Procedure: {publicProjection.procedure.procedureId} (step {publicProjection.procedure.stepIndex + 1})
		</p>
	{/if}

	<section aria-label="Major deck">
		<h3>Major deck</h3>
		<p>{publicProjection.majorDrawCount} remaining</p>
		<div class="discard-top">
			<TarotCard card={majorDiscard.card} faceDown={majorDiscard.faceDown} size="sm" />
		</div>
	</section>

	<section aria-label="Player deck">
		<h3>Player deck</h3>
		<p>{publicProjection.playerDrawCount} remaining</p>
		<div class="discard-top">
			<TarotCard card={playerDiscard.card} faceDown={playerDiscard.faceDown} size="sm" />
		</div>
	</section>

	{#if publicProjection.pendingZoneCounts.length > 0}
		<section aria-label="Pending selections">
			<h3>Pending</h3>
			<ul>
				{#each publicProjection.pendingZoneCounts as zone (zone.id)}
					<li>{zone.id}: {zone.count} card{zone.count === 1 ? '' : 's'}</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if role === 'gm'}
		<section aria-label="Table controls">
			<h3>Controls</h3>
			{#if canDeal}
				<button
					type="button"
					disabled={dealDisabled}
					title={dealDisabled ? 'No other hands to deal to yet' : undefined}
					onclick={onDeal}
				>
					Deal a card to each hand
				</button>
			{/if}
			{#if canEndRound}
				<button type="button" onclick={onEndRound}>End round</button>
			{/if}

			{#if sessionStatus === 'active'}
				<button type="button" onclick={onFreeze}>Freeze table</button>
			{:else if sessionStatus === 'frozen'}
				<button type="button" onclick={onRecover}>Resume table</button>
			{/if}

			{#if !confirmingEnd}
				<button type="button" class="end-session" onclick={() => (confirmingEnd = true)}>End session</button>
			{:else}
				<div class="confirm-end" data-testid="end-session-confirm">
					<p>End the session? Every private hand is permanently cleared.</p>
					<div class="confirm-actions">
						<button type="button" class="end-session" onclick={confirmEndSession}>Confirm end</button>
						<button type="button" onclick={() => (confirmingEnd = false)}>Cancel</button>
					</div>
				</div>
			{/if}
		</section>
	{/if}
</aside>

<style>
	.phase-rail {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		padding: 1rem;
		border: 1px solid color-mix(in oklab, var(--ink) 18%, transparent);
	}
	.phase {
		margin: 0;
		font-family: var(--font-subhead);
		text-transform: capitalize;
	}
	.procedure {
		margin: 0;
		color: var(--ink-soft);
		font-size: 0.85rem;
	}
	h3 {
		margin: 0 0 0.35rem;
		font-size: 0.9rem;
	}
	section p {
		margin: 0 0 0.5rem;
		color: var(--ink-soft);
		font-size: 0.85rem;
	}
	ul {
		margin: 0;
		padding-left: 1.1rem;
		font-size: 0.85rem;
		color: var(--ink-soft);
	}
	section[aria-label='Table controls'] {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	button {
		border: 1px solid color-mix(in oklab, var(--accent) 55%, transparent);
		background: none;
		padding: 0.45rem 0.75rem;
		font-family: var(--font-subhead);
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	button.end-session {
		border-color: color-mix(in oklab, #b3261e 55%, transparent);
		color: #b3261e;
	}
	.confirm-end {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.6rem;
		border: 1px solid color-mix(in oklab, #b3261e 45%, transparent);
	}
	.confirm-end p {
		margin: 0;
		font-size: 0.8rem;
		color: var(--ink-soft);
	}
	.confirm-actions {
		display: flex;
		gap: 0.5rem;
	}
</style>
