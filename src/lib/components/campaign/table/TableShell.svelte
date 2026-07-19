<script lang="ts">
	/**
	 * The table-first layout shell (Task 7 brief Step 3 / controller amendment
	 * 7): desktop is a left phase rail, a central table column (public table +
	 * private hand pinned to its bottom), and a right public log; mobile leads
	 * with the table, tucks the phase rail and log behind drawers, and turns
	 * the hand into a horizontal scroller. No map/movement/health/range/
	 * denizen HP/voice/chat — only the generic card commands the projection's
	 * `legalCommands` actually allows.
	 *
	 * Presentation + composition only: every mutation goes through
	 * `onSendCommand`, which the page wires to the store's `sendCommand` — this
	 * component never fetches anything itself.
	 */
	import PhaseRail from './PhaseRail.svelte';
	import PublicTable from './PublicTable.svelte';
	import PrivateHand from './PrivateHand.svelte';
	import PrivateFacedown from './PrivateFacedown.svelte';
	import EventLog from './EventLog.svelte';
	import MobileTableDrawers from './MobileTableDrawers.svelte';
	import type { SessionCommand } from '$lib/types/session';
	import {
		COMMAND_ERROR_MESSAGE,
		type LifecycleAction,
		type SendCommandResult,
		type TableSession,
		type WireSessionEventLike
	} from '$lib/stores/campaign-session.svelte';
	import type { SessionGmProjection, SessionPlayerProjection } from '$lib/types/session';

	let {
		role,
		userId,
		session,
		events,
		onSendCommand,
		onSendLifecycleAction
	}: {
		role: 'gm' | 'player';
		userId: string;
		session: TableSession;
		events: WireSessionEventLike[];
		onSendCommand: (command: SessionCommand, expectedStructuralVersion?: number) => Promise<SendCommandResult>;
		onSendLifecycleAction: (action: LifecycleAction) => Promise<SendCommandResult>;
	} = $props();

	const sessionStatus = $derived(session.status);

	// Zone ids follow the seeding convention in
	// `src/lib/server/session/repository.ts`'s `standardPrivateZonesForMember`
	// (`hand:<userId>`/`facedown:<userId>`/`prepared:<userId>`, seeded only for
	// campaign *members* — the GM never gets one) and `standardPublicZones`
	// (`played`, the public zone `play`/`discard` target below). Never guessed
	// beyond what those two functions actually create.
	const ownHandZoneId = $derived(role === 'gm' ? 'gmHand' : `hand:${userId}`);
	const ownFacedownZoneId = $derived(role === 'player' ? `facedown:${userId}` : null);
	const ownPreparedZoneId = $derived(role === 'player' ? `prepared:${userId}` : null);
	const legalCommands = $derived(session.projection.legalCommands);
	const canDraw = $derived(legalCommands.includes('draw'));
	const canEndRound = $derived(legalCommands.includes('end-round'));
	const canPlay = $derived(legalCommands.includes('play'));
	// The GM has no facedown zone of their own (only campaign members are
	// seeded one) — `place-facedown` from the GM's hand would have nowhere
	// legal to land, so it's a player-only control regardless of the coarse
	// `legalCommands` gate.
	const canPlaceFacedown = $derived(role === 'player' && legalCommands.includes('place-facedown'));
	const canDiscard = $derived(legalCommands.includes('discard'));
	// Same reasoning as `canPlaceFacedown`: reveal only ever targets a
	// player's own facedown zone, which the GM doesn't have.
	const canReveal = $derived(role === 'player' && legalCommands.includes('reveal'));

	const ownCards = $derived(
		role === 'gm'
			? (session.projection as SessionGmProjection).gmHand
			: (session.projection as SessionPlayerProjection).privateHand
	);

	const ownFacedownCards = $derived(
		role === 'player' ? (session.projection as SessionPlayerProjection).privateFacedown : []
	);

	const otherHands = $derived(
		Object.entries(session.projection.public.playerHandCounts)
			.filter(([id]) => role === 'gm' || id !== userId)
			.map(([id, count]) => ({ id, count }))
	);

	/**
	 * Scope call (see the UI-fixes report, corrected after review): a player-
	 * initiated `transfer` into another player's hand is always rejected —
	 * `card-commands.ts`'s `actorMayAccessZone` lets a player act only on a
	 * private zone they own — so a player's only reachable transfer
	 * destination beyond what Play/Play-face-down already cover is their own
	 * prepared zone.
	 *
	 * The GM has no `transfer` control at all. It isn't just an authorization
	 * question — a "GM hands a card to a player's hand" control can *never*
	 * succeed regardless of who's allowed to attempt it: `gmHand` only ever
	 * holds major-deck cards, every `hand:<userId>` zone is declared
	 * player-deck-only (`zones.ts`'s `listZoneDescriptors`), and
	 * `handleGenericMove`'s deck check (`card-commands.ts:328-330`,
	 * `destination.deck !== 'both' && cardEntry.deck !== destination.deck`)
	 * rejects every cross-deck move. That's also rules-correct: players hold
	 * minors + the Fool, the GM holds majors — `transfer` exists for
	 * player-to-player moves (Counsel/High Chant/Guardian Angel-style), not
	 * for the GM to deal a major into a player's hand (that's what `deal`
	 * is for). So the GM simply gets no Transfer control — Play/Play face
	 * down/Discard/Reveal only.
	 */
	const transferTargets = $derived(
		role === 'player' && ownPreparedZoneId ? [{ zoneId: ownPreparedZoneId, label: 'Your prepared items' }] : []
	);

	const dealTargetZoneIds = $derived(Object.keys(session.projection.public.playerHandCounts).map((id) => `hand:${id}`));
	const canDeal = $derived(legalCommands.includes('deal'));
	// Issue 2: `dealToHands` builds its destination list from the *same*
	// `playerHandCounts` the API will validate against — with no other
	// connected members that list is empty, the command is invalid before it
	// is ever sent, and the button must say so instead of silently doing
	// nothing.
	const dealDisabled = $derived(dealTargetZoneIds.length === 0);

	let actionError = $state<string | null>(null);

	async function draw(): Promise<void> {
		const result = await onSendCommand({
			type: 'draw',
			deck: role === 'gm' ? 'major' : 'player',
			destinationZoneId: ownHandZoneId,
			count: 1
		});
		actionError = result.ok ? null : (result.message ?? null);
	}

	async function dealToHands(): Promise<void> {
		if (dealTargetZoneIds.length === 0) {
			// Defense in depth: the button is disabled in this state (see the
			// template below), but a command built from a stale render or a
			// direct call must still surface the store's fixed, generic error
			// rather than vanish silently.
			actionError = COMMAND_ERROR_MESSAGE;
			return;
		}
		const result = await onSendCommand({
			type: 'deal',
			deck: 'player',
			destinationZoneIds: dealTargetZoneIds,
			countPerDestination: 1
		});
		actionError = result.ok ? null : (result.message ?? null);
	}

	async function endRound(): Promise<void> {
		const result = await onSendCommand({ type: 'end-round' }, session.sessionVersion);
		actionError = result.ok ? null : (result.message ?? null);
	}

	async function freezeTable(): Promise<void> {
		const result = await onSendLifecycleAction('freeze');
		actionError = result.ok ? null : (result.message ?? null);
	}

	async function recoverTable(): Promise<void> {
		const result = await onSendLifecycleAction('recover');
		actionError = result.ok ? null : (result.message ?? null);
	}

	async function endSession(): Promise<void> {
		const result = await onSendLifecycleAction('end');
		actionError = result.ok ? null : (result.message ?? null);
	}

	async function playCard(cardId: string): Promise<void> {
		const result = await onSendCommand({
			type: 'play',
			sourceZoneId: ownHandZoneId,
			cardId,
			destinationZoneId: 'played'
		});
		actionError = result.ok ? null : (result.message ?? null);
	}

	async function placeCardFacedown(cardId: string): Promise<void> {
		if (!ownFacedownZoneId) return;
		const result = await onSendCommand({
			type: 'place-facedown',
			sourceZoneId: ownHandZoneId,
			cardId,
			destinationZoneId: ownFacedownZoneId
		});
		actionError = result.ok ? null : (result.message ?? null);
	}

	async function discardCard(cardId: string): Promise<void> {
		const result = await onSendCommand({
			type: 'discard',
			sourceZoneId: ownHandZoneId,
			cardId,
			// A GM's hand only ever holds major-deck cards, a player's hand
			// only ever holds player-deck cards (see `handleDraw`/`handleDeal`'s
			// deck check against each zone's fixed `deck`) — the matching
			// discard pile is therefore determined by role, never guessed.
			destinationZoneId: role === 'gm' ? 'majorDiscard' : 'playerDiscard'
		});
		actionError = result.ok ? null : (result.message ?? null);
	}

	async function transferCard(cardId: string, destinationZoneId: string): Promise<void> {
		const result = await onSendCommand({
			type: 'transfer',
			sourceZoneId: ownHandZoneId,
			cardId,
			destinationZoneId
		});
		actionError = result.ok ? null : (result.message ?? null);
	}

	async function revealFacedownCard(cardId: string): Promise<void> {
		if (!ownFacedownZoneId) return;
		const result = await onSendCommand({ type: 'reveal', zoneId: ownFacedownZoneId, cardId });
		actionError = result.ok ? null : (result.message ?? null);
	}

	let isDesktop = $state(true);
	$effect(() => {
		if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
		const query = window.matchMedia('(min-width: 768px)');
		const update = () => {
			isDesktop = query.matches;
		};
		update();
		query.addEventListener('change', update);
		return () => query.removeEventListener('change', update);
	});
</script>

<div class="table-shell" data-testid="table-shell">
	{#if sessionStatus === 'frozen'}
		<p class="frozen-banner" role="status" data-testid="frozen-banner">
			The GM has frozen the table.{role === 'player' ? ' Actions are paused until they resume it.' : ''}
		</p>
	{/if}

	{#if actionError}
		<p class="action-error" role="alert">{actionError}</p>
	{/if}

	{#if isDesktop}
		<div class="desktop-layout">
			<PhaseRail
				publicProjection={session.projection.public}
				{role}
				{canDeal}
				{dealDisabled}
				{canEndRound}
				onDeal={dealToHands}
				onEndRound={endRound}
				{sessionStatus}
				onFreeze={freezeTable}
				onRecover={recoverTable}
				onEndSession={endSession}
			/>
			<div class="table-column">
				<PublicTable publicProjection={session.projection.public} {otherHands} />
				<PrivateHand
					cards={ownCards}
					heading={role === 'gm' ? "GM's hand" : 'Your hand'}
					{canDraw}
					onDraw={draw}
					{canPlay}
					{canPlaceFacedown}
					{canDiscard}
					{transferTargets}
					onPlay={playCard}
					onPlaceFacedown={placeCardFacedown}
					onDiscard={discardCard}
					onTransfer={transferCard}
				/>
				{#if role === 'player'}
					<PrivateFacedown cards={ownFacedownCards} {canReveal} onReveal={revealFacedownCard} />
				{/if}
			</div>
			<EventLog {events} />
		</div>
	{:else}
		<div class="mobile-layout">
			<!-- Table-first (review round 2 fix): real DOM order, not CSS
			     `order` — PublicTable must precede the drawers/hand so the table
			     genuinely leads on mobile, not just visually. -->
			<PublicTable publicProjection={session.projection.public} {otherHands} />
			<MobileTableDrawers
				publicProjection={session.projection.public}
				{role}
				{canDeal}
				{dealDisabled}
				{canEndRound}
				onDeal={dealToHands}
				onEndRound={endRound}
				{sessionStatus}
				onFreeze={freezeTable}
				onRecover={recoverTable}
				onEndSession={endSession}
				{events}
			/>
			<PrivateHand
				cards={ownCards}
				heading={role === 'gm' ? "GM's hand" : 'Your hand'}
				{canDraw}
				onDraw={draw}
				layout="mobile"
				{canPlay}
				{canPlaceFacedown}
				{canDiscard}
				{transferTargets}
				onPlay={playCard}
				onPlaceFacedown={placeCardFacedown}
				onDiscard={discardCard}
				onTransfer={transferCard}
			/>
			{#if role === 'player'}
				<PrivateFacedown cards={ownFacedownCards} {canReveal} onReveal={revealFacedownCard} layout="mobile" />
			{/if}
		</div>
	{/if}
</div>

<style>
	.table-shell {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.action-error {
		margin: 0;
		padding: 0.5rem 0.75rem;
		border: 1px solid color-mix(in oklab, #b3261e 60%, transparent);
		color: #b3261e;
		font-size: 0.85rem;
	}
	.frozen-banner {
		margin: 0;
		padding: 0.6rem 0.9rem;
		border: 1px solid color-mix(in oklab, var(--accent) 55%, transparent);
		background: color-mix(in oklab, var(--accent) 12%, transparent);
		font-family: var(--font-subhead);
		font-size: 0.9rem;
	}
	.desktop-layout {
		display: grid;
		grid-template-columns: 16rem minmax(0, 1fr) 18rem;
		gap: 1.25rem;
		align-items: start;
	}
	.table-column {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.mobile-layout {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
</style>
