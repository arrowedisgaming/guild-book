<script lang="ts">
	/**
	 * The Challenge participant's own action bar (Increment 3 Task 6): placing
	 * their own Initiative (`stage: 'initiative-placement'`), then — once
	 * turns begin — acting on WHOEVER'S turn is currently active, a player's
	 * own seat or the GM's own enemy seat (the GM never gets a control for a
	 * player's turn here; the engine's own GM-override authority is a safety
	 * net, not a guided-UI feature — see the brief's scope). Renders exactly
	 * the actions `legalCommands` offers: `place-initiative`,
	 * `play-action`/`gm-play`, `play-minor-action`/`gm-minor-action`,
	 * `play-fool`, `end-turn`. Card identities come from the OWN per-zone
	 * Challenge hand (O2: `privateHandsByZoneId`, never the merged
	 * `privateHand`) or, for the GM, the ordinary `gmHand`.
	 */
	import { renderableCard } from '$lib/stores/campaign-session.svelte';
	import TarotCard from '$lib/components/tarot/TarotCard.svelte';
	import { FOOL_CARD_ID } from '$lib/engine/session/card-commands';
	import { challengeHandZoneId } from '$lib/engine/session/procedures/challenge/reducer';
	import { SUIT_IDS, SUIT_LABELS, type SuitId } from '$lib/types/common';
	import type { ChallengeCommand } from '$lib/engine/session/procedures/challenge/command';
	import type { ChallengePlayerProjection, ChallengeProjection } from '$lib/engine/session/procedures/challenge/projection';
	import type { CardSlot, SessionGmProjection, SessionPlayerProjection } from '$lib/types/session';
	import type { ChallengeActionRunner } from './challenge-action.svelte';

	let {
		role,
		genericProjection,
		challenge,
		legalCommands,
		actionRunner
	}: {
		role: 'gm' | 'player';
		genericProjection: SessionPlayerProjection | SessionGmProjection;
		challenge: ChallengeProjection;
		legalCommands: ChallengeCommand['type'][];
		actionRunner: ChallengeActionRunner;
	} = $props();

	function has(type: ChallengeCommand['type']): boolean {
		return legalCommands.includes(type);
	}

	const actingTenureId = $derived(role === 'player' ? (challenge as ChallengePlayerProjection).actingTenureId : null);

	const ownHand = $derived.by((): CardSlot[] => {
		if (role === 'gm') return (genericProjection as SessionGmProjection).gmHand;
		if (!actingTenureId) return [];
		return (genericProjection as SessionPlayerProjection).privateHandsByZoneId[challengeHandZoneId(actingTenureId)] ?? [];
	});

	// -----------------------------------------------------------------------
	// Initiative placement (player-only — the GM's own enemy Initiative is a
	// round-level control, `GmChallengeControls`, not a per-participant one)
	// -----------------------------------------------------------------------

	const canPlaceInitiative = $derived(role === 'player' && has('place-initiative'));

	async function placeInitiative(cardId: string): Promise<void> {
		if (!actingTenureId) return;
		await actionRunner.run({ type: 'place-initiative', tenureId: actingTenureId, cardId });
	}

	// -----------------------------------------------------------------------
	// Active-turn actions
	// -----------------------------------------------------------------------

	const canPlay = $derived(has(role === 'gm' ? 'gm-play' : 'play-action'));
	const canMinorAction = $derived(has(role === 'gm' ? 'gm-minor-action' : 'play-minor-action'));
	const canPlayFool = $derived(role === 'player' && has('play-fool'));
	const canEndTurn = $derived(has('end-turn'));

	/**
	 * Whether THIS viewer has any card-spending action of their own to take
	 * right now — gates the hand-of-cards listing below. Review round fix:
	 * this used to be decided by a client-computed `controlsActiveTurn`
	 * (comparing the viewer's own tenure/role against
	 * `challenge.activeTurnIndex`'s entry) that hid the ENTIRE section
	 * whenever it was false — but `legalChallengeBaseCommands` already offers
	 * the GM `end-turn` whenever ANY turn is active (their own oversight
	 * authority to end anyone's turn — `turns.ts`'s `endTurn` itself
	 * authorizes this), independent of whose turn it is. Gating on
	 * `controlsActiveTurn` silently hid that legitimate GM override during a
	 * PLAYER's active turn — legality logic in a component, against O1.
	 * `canPlay`/`canMinorAction`/`canPlayFool` are themselves already
	 * correctly actor/stage/turn-scoped by the server (each only ever true
	 * when it genuinely is this viewer's own moment), so no separate
	 * client-side "is it my turn" check is needed for them at all.
	 */
	const hasOwnTurnActions = $derived(canPlay || canMinorAction || canPlayFool);
	const showTurnSection = $derived(hasOwnTurnActions || canEndTurn);

	let selectedSuit = $state<SuitId>('swords');
	let foolArmed = $state(false);

	async function playAction(cardId: string): Promise<void> {
		if (role === 'gm') {
			await actionRunner.run({ type: 'gm-play', cardId });
		} else if (actingTenureId) {
			await actionRunner.run({ type: 'play-action', tenureId: actingTenureId, cardId });
		}
	}

	async function playMinorAction(cardId: string): Promise<void> {
		if (role === 'gm') {
			await actionRunner.run({ type: 'gm-minor-action', cardId });
		} else if (actingTenureId) {
			await actionRunner.run({ type: 'play-minor-action', tenureId: actingTenureId, cardId, actionSuit: selectedSuit });
		}
	}

	async function pairWithFool(pairedCardId: string): Promise<void> {
		if (!actingTenureId) return;
		await actionRunner.run({ type: 'play-fool', tenureId: actingTenureId, pairedCardId });
		foolArmed = false;
	}

	async function endTurn(): Promise<void> {
		await actionRunner.run({ type: 'end-turn' });
	}
</script>

{#if canPlaceInitiative}
	<section class="turn-controls" data-testid="initiative-placement-controls" aria-label="Place your Initiative">
		<h3>Place your Initiative</h3>
		{#if ownHand.length === 0}
			<p class="empty">No Challenge cards in hand yet.</p>
		{:else}
			<ul class="hand">
				{#each ownHand as slot, index (index)}
					{@const rendered = renderableCard(slot)}
					{@const cardId = slot.hidden ? undefined : slot.id}
					<li data-testid="initiative-hand-card">
						<TarotCard card={rendered.card} faceDown={rendered.faceDown} size="sm" />
						{#if cardId}
							<button type="button" disabled={actionRunner.pending} onclick={() => placeInitiative(cardId)}>Place as Initiative</button>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
		{#if actionRunner.error}
			<p class="action-error" role="alert">{actionRunner.error}</p>
		{/if}
	</section>
{/if}

{#if showTurnSection}
	<section class="turn-controls" data-testid="turn-controls" aria-label="Your turn">
		{#if canPlayFool}
			<button
				type="button"
				class="fool-toggle"
				aria-pressed={foolArmed}
				disabled={actionRunner.pending}
				onclick={() => (foolArmed = !foolArmed)}
				data-testid="play-fool-toggle"
			>
				{foolArmed ? 'Cancel pairing the Fool' : 'Play the Fool (paired)'}
			</button>
		{/if}

		{#if canMinorAction && role === 'player'}
			<label class="suit-picker">
				Minor action suit
				<select bind:value={selectedSuit} aria-label="Minor action suit">
					{#each SUIT_IDS as suit (suit)}
						<option value={suit}>{SUIT_LABELS[suit]}</option>
					{/each}
				</select>
			</label>
		{/if}

		{#if hasOwnTurnActions}
			{#if ownHand.length === 0}
				<p class="empty">No Challenge cards in hand.</p>
			{:else}
				<ul class="hand">
					{#each ownHand as slot, index (index)}
						{@const rendered = renderableCard(slot)}
						{@const cardId = slot.hidden ? undefined : slot.id}
						<li data-testid="turn-hand-card">
							<TarotCard card={rendered.card} faceDown={rendered.faceDown} size="sm" />
							{#if cardId}
								{#if foolArmed}
									{#if cardId !== FOOL_CARD_ID}
										<button type="button" disabled={actionRunner.pending} onclick={() => pairWithFool(cardId)}> Pair with Fool </button>
									{/if}
								{:else}
									{#if canPlay}
										<button type="button" disabled={actionRunner.pending} onclick={() => playAction(cardId)}>Play</button>
									{/if}
									{#if canMinorAction}
										<button type="button" disabled={actionRunner.pending} onclick={() => playMinorAction(cardId)}>Minor action</button>
									{/if}
								{/if}
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		{/if}

		{#if canEndTurn}
			<button type="button" class="end-turn" disabled={actionRunner.pending} onclick={endTurn} data-testid="end-turn-button">End turn</button>
		{/if}

		{#if actionRunner.error}
			<p class="action-error" role="alert">{actionRunner.error}</p>
		{/if}
	</section>
{/if}

<style>
	.turn-controls {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		padding: 0.75rem;
		border: 1px solid var(--accent);
	}
	h3 {
		margin: 0;
		font-size: 0.9rem;
	}
	.hand {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.hand li {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.25rem;
	}
	.empty {
		margin: 0;
		font-size: 0.85rem;
		color: var(--ink-soft);
	}
	.suit-picker {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.8rem;
	}
	button {
		border: 1px solid color-mix(in oklab, var(--accent) 55%, transparent);
		background: none;
		padding: 0.3rem 0.55rem;
		font-family: var(--font-subhead);
		font-size: 0.75rem;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	button:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.end-turn {
		align-self: flex-start;
	}
	.fool-toggle[aria-pressed='true'] {
		background: color-mix(in oklab, var(--accent) 18%, transparent);
	}
	.action-error {
		margin: 0;
		padding: 0.4rem 0.6rem;
		border: 1px solid color-mix(in oklab, #b3261e 60%, transparent);
		color: #b3261e;
		font-size: 0.8rem;
	}
</style>
