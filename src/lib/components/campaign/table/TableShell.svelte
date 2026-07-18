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
	import EventLog from './EventLog.svelte';
	import MobileTableDrawers from './MobileTableDrawers.svelte';
	import type { SessionCommand } from '$lib/types/session';
	import type {
		SendCommandResult,
		TableSession,
		WireSessionEventLike
	} from '$lib/stores/campaign-session.svelte';
	import type { SessionGmProjection, SessionPlayerProjection } from '$lib/types/session';

	let {
		role,
		userId,
		session,
		events,
		onSendCommand
	}: {
		role: 'gm' | 'player';
		userId: string;
		session: TableSession;
		events: WireSessionEventLike[];
		onSendCommand: (command: SessionCommand, expectedStructuralVersion?: number) => Promise<SendCommandResult>;
	} = $props();

	const ownHandZoneId = $derived(role === 'gm' ? 'gmHand' : `hand:${userId}`);
	const legalCommands = $derived(session.projection.legalCommands);
	const canDraw = $derived(legalCommands.includes('draw'));
	const canDeal = $derived(legalCommands.includes('deal'));
	const canEndRound = $derived(legalCommands.includes('end-round'));

	const ownCards = $derived(
		role === 'gm'
			? (session.projection as SessionGmProjection).gmHand
			: (session.projection as SessionPlayerProjection).privateHand
	);

	const otherHands = $derived(
		Object.entries(session.projection.public.playerHandCounts)
			.filter(([id]) => role === 'gm' || id !== userId)
			.map(([id, count]) => ({ id, count }))
	);

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
		const destinationZoneIds = Object.keys(session.projection.public.playerHandCounts).map((id) => `hand:${id}`);
		if (destinationZoneIds.length === 0) return;
		const result = await onSendCommand({
			type: 'deal',
			deck: 'player',
			destinationZoneIds,
			countPerDestination: 1
		});
		actionError = result.ok ? null : (result.message ?? null);
	}

	async function endRound(): Promise<void> {
		const result = await onSendCommand({ type: 'end-round' }, session.sessionVersion);
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
	{#if actionError}
		<p class="action-error" role="alert">{actionError}</p>
	{/if}

	{#if isDesktop}
		<div class="desktop-layout">
			<PhaseRail
				publicProjection={session.projection.public}
				{role}
				{canDeal}
				{canEndRound}
				onDeal={dealToHands}
				onEndRound={endRound}
			/>
			<div class="table-column">
				<PublicTable publicProjection={session.projection.public} {otherHands} />
				<PrivateHand
					cards={ownCards}
					heading={role === 'gm' ? "GM's hand" : 'Your hand'}
					{canDraw}
					onDraw={draw}
				/>
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
				{canEndRound}
				onDeal={dealToHands}
				onEndRound={endRound}
				{events}
			/>
			<PrivateHand
				cards={ownCards}
				heading={role === 'gm' ? "GM's hand" : 'Your hand'}
				{canDraw}
				onDraw={draw}
				layout="mobile"
			/>
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
