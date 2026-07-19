<script lang="ts">
	/**
	 * Mobile layout support (Task 7 brief Step 3 / controller amendment 7):
	 * the table leads on narrow viewports, so the phase rail and event log
	 * move into accessible `<details>` drawers instead of fixed columns.
	 * Reuses `PhaseRail`/`EventLog` verbatim — no duplicated rendering logic.
	 */
	import PhaseRail from './PhaseRail.svelte';
	import EventLog from './EventLog.svelte';
	import type { SessionPublicProjection, SessionStatus } from '$lib/types/session';
	import type { WireSessionEventLike } from '$lib/stores/campaign-session.svelte';

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
		onEndSession,
		events
	}: {
		publicProjection: SessionPublicProjection;
		role: 'gm' | 'player';
		canDeal: boolean;
		dealDisabled?: boolean;
		canEndRound: boolean;
		onDeal: () => void | Promise<void>;
		onEndRound: () => void | Promise<void>;
		sessionStatus: SessionStatus;
		onFreeze: () => void | Promise<void>;
		onRecover: () => void | Promise<void>;
		onEndSession: () => void | Promise<void>;
		events: WireSessionEventLike[];
	} = $props();
</script>

<div class="mobile-drawers" data-testid="mobile-drawers">
	<details>
		<summary>Phase &amp; decks</summary>
		<PhaseRail
			{publicProjection}
			{role}
			{canDeal}
			{dealDisabled}
			{canEndRound}
			{onDeal}
			{onEndRound}
			{sessionStatus}
			{onFreeze}
			{onRecover}
			{onEndSession}
		/>
	</details>
	<details>
		<summary>Table log</summary>
		<EventLog {events} />
	</details>
</div>

<style>
	.mobile-drawers {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	summary {
		cursor: pointer;
		padding: 0.6rem 0.75rem;
		border: 1px solid color-mix(in oklab, var(--ink) 18%, transparent);
		font-family: var(--font-subhead);
	}
</style>
