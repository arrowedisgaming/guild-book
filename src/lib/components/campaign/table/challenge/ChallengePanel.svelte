<script lang="ts">
	/**
	 * The guided Challenge table (Increment 3 Task 6) — composition root for
	 * the five Challenge components. Presentation + composition only: every
	 * mutation goes through the shared `actionRunner` (`challenge-action.svelte.ts`),
	 * which wraps `onSendChallengeCommand` (the store's `sendChallengeCommand`).
	 * Nothing here computes legality — every control below renders from
	 * `session.challengeLegalCommands`/`session.challengeProjection.legalCommands`
	 * (O1). `session.challengeProjection` is `null` until a round begins; the
	 * GM's "Begin Challenge" affordance still renders in that case because
	 * `challengeLegalCommands` (unlike the full projection) is computed
	 * server-side independent of whether a round exists.
	 */
	import { createChallengeAction } from './challenge-action.svelte';
	import GmChallengeControls from './GmChallengeControls.svelte';
	import InitiativeRow from './InitiativeRow.svelte';
	import ModifierControls from './ModifierControls.svelte';
	import TurnControls from './TurnControls.svelte';
	import type { ChallengeCommand } from '$lib/engine/session/procedures/challenge/command';
	import type { ChallengeGmProjection } from '$lib/engine/session/procedures/challenge/projection';
	import { CHALLENGE_GM_TENURE_ID } from '$lib/engine/session/procedures/challenge/reducer';
	import type { ActiveChallengeTenureView } from '$lib/server/campaign/page-data';
	import type { SendCommandResult, TableSession, WireSessionEventLike } from '$lib/stores/campaign-session.svelte';
	import type { SessionGmProjection, SessionPlayerProjection } from '$lib/types/session';

	let {
		role,
		userId,
		session,
		events,
		challengeRoster,
		enemyThreatOptions,
		onSendChallengeCommand
	}: {
		role: 'gm' | 'player';
		userId: string;
		session: TableSession;
		events: WireSessionEventLike[];
		challengeRoster: ActiveChallengeTenureView[];
		enemyThreatOptions: { id: string; name: string }[];
		onSendChallengeCommand: (command: ChallengeCommand, commandId?: string) => Promise<SendCommandResult>;
	} = $props();

	// Wrapped in a closure (rather than passing `onSendChallengeCommand`
	// straight through) so `createChallengeAction` always calls the CURRENT
	// prop value, not just the one captured when this component first
	// mounted (`state_referenced_locally`).
	const actionRunner = createChallengeAction((command, commandId) => onSendChallengeCommand(command, commandId));

	const challenge = $derived(session.challengeProjection);
	const legalCommands = $derived(session.challengeLegalCommands);
	const visible = $derived(challenge !== null || (role === 'gm' && legalCommands.includes('begin-challenge')));

	const STAGE_LABELS: Record<string, string> = {
		setup: 'Setting up',
		deal: 'Dealing Challenge cards',
		'initiative-placement': 'Placing Initiative',
		'initiative-reveal': 'Initiative revealed',
		turns: 'Taking turns',
		'round-cleanup': 'Ending the round',
		complete: 'Challenge complete'
	};

	// ---------------------------------------------------------------------
	// Accessibility announcements (Step 3): deal count, initiative reveal/
	// order, active turn, public play, round transition, completion. Sourced
	// from the already-scrubbed public event log — never a card identity
	// beyond what the events themselves already carry (a revealed Initiative
	// deliberately does; an ordinary played card does too, once played into a
	// PUBLIC zone every projection already shows in full).
	// ---------------------------------------------------------------------

	const CHALLENGE_EVENT_KINDS = new Set([
		'challenge-begun',
		'challenge-hand-sizes-calculated',
		'challenge-initiative-revealed',
		'challenge-turns-begun',
		'challenge-turn-advanced',
		'challenge-turns-completed',
		'challenge-card-played',
		'challenge-minor-action-played',
		'fool-interrupt-played',
		'extra-turn-scheduled',
		'challenge-round-ended',
		'challenge-participant-died'
	]);

	function isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === 'object' && value !== null;
	}

	function describeChallengeEvent(event: WireSessionEventLike): string {
		const payload = isRecord(event.publicPayload) ? event.publicPayload : {};
		switch (event.kind) {
			case 'challenge-begun': {
				const count = Array.isArray(payload.participantTenureIds) ? payload.participantTenureIds.length : 0;
				return `Challenge begun with ${count} participant${count === 1 ? '' : 's'}.`;
			}
			case 'challenge-hand-sizes-calculated':
				return `Dealt ${String(payload.playerHandSize ?? '?')} card(s) to each player and ${String(payload.gmHandSize ?? '?')} to the GM.`;
			case 'challenge-initiative-revealed': {
				const tied = Array.isArray(payload.tiedGroups) && payload.tiedGroups.length > 0;
				return `Initiative revealed.${tied ? ' A tie was recorded — the table decides who goes first.' : ''}`;
			}
			case 'challenge-turns-begun':
				return `Turns begin — ${String(payload.tenureId ?? 'the first seat')} acts first.`;
			case 'challenge-turn-advanced':
				return `${String(payload.toTenureId ?? 'the next seat')}'s turn.`;
			case 'challenge-turns-completed':
				return 'Every seat has acted this round.';
			case 'challenge-card-played':
				return `${String(payload.tenureId ?? 'A seat')} played ${payload.actionKind === 'minor-action' ? 'a minor action' : 'a card'}.`;
			case 'challenge-minor-action-played':
				return `${String(payload.tenureId ?? 'A seat')} played a minor action.`;
			case 'fool-interrupt-played':
				return `${String(payload.tenureId ?? 'A seat')} played the Fool — an extra turn follows.`;
			case 'extra-turn-scheduled':
				return `${String(payload.tenureId ?? 'A seat')} takes an extra turn.`;
			case 'challenge-round-ended':
				return `Round ${String(payload.completedRound ?? '')} ended. Round ${String(payload.nextRound ?? '')} begins.`;
			case 'challenge-participant-died':
				return `${String(payload.tenureId ?? 'A participant')} has left the Challenge.`;
			default:
				return '';
		}
	}

	const announcement = $derived.by(() => {
		if (challenge?.stage === 'complete') return 'The Challenge is complete.';
		for (let i = events.length - 1; i >= 0; i--) {
			if (CHALLENGE_EVENT_KINDS.has(events[i].kind)) return describeChallengeEvent(events[i]);
		}
		return '';
	});

	/**
	 * Public turn/budget counters (Step 2, review round: previously omitted
	 * entirely — `challenge.budgets` was carried in the projection but shown
	 * nowhere, so a player had no way to see how many cards they could still
	 * spend this turn). Driven ENTIRELY from projection fields — `budgets`,
	 * `activeTurnIndex`, `initiativeOrder`, and the content-hydrated caps
	 * (`cardsPerInitiativeTurn`/`gmPlayBudget`, both O1-safe: game rules, not
	 * secret) — never a client-side legality computation. Visible to every
	 * viewer regardless of role, since none of this is per-actor secret.
	 */
	const activeTurnBudget = $derived.by(() => {
		if (!challenge || challenge.activeTurnIndex === null) return null;
		const entry = challenge.initiativeOrder[challenge.activeTurnIndex];
		if (!entry) return null;
		const isParticipant = challenge.participantTenureIds.includes(entry.tenureId);
		const budgetKey = isParticipant ? entry.tenureId : CHALLENGE_GM_TENURE_ID;
		const budget = challenge.budgets[budgetKey];
		if (!budget) return null;
		return {
			turnNumber: challenge.activeTurnIndex + 1,
			turnCount: challenge.initiativeOrder.length,
			cardsThisTurn: budget.cardsThisTurn,
			cap: isParticipant ? challenge.cardsPerInitiativeTurn : challenge.gmPlayBudget,
			actionTaken: budget.actionTaken
		};
	});
</script>

{#if visible}
	<section class="challenge-panel" data-testid="challenge-panel" aria-label="Challenge">
		{#if challenge}
			<header class="challenge-header">
				<h2>Challenge — Round {challenge.round}</h2>
				<p class="stage" data-testid="challenge-stage">{STAGE_LABELS[challenge.stage] ?? challenge.stage}</p>
			</header>
		{:else}
			<header class="challenge-header">
				<h2>Challenge</h2>
			</header>
		{/if}

		<p class="sr-only" role="status" aria-live="polite" data-testid="challenge-announcement">{announcement}</p>

		{#if challenge && challenge.initiativeOrder.length > 0}
			<ol class="initiative-order" aria-label="Initiative order" data-testid="initiative-order">
				{#each challenge.initiativeOrder as entry (entry.index)}
					<InitiativeRow {entry} tenureOwners={challenge.tenureOwners} roster={challengeRoster} viewerUserId={userId} isActive={challenge.activeTurnIndex === entry.index} />
				{/each}
			</ol>
		{/if}

		{#if activeTurnBudget}
			<p class="turn-budget" data-testid="turn-budget-counter">
				Turn {activeTurnBudget.turnNumber} of {activeTurnBudget.turnCount} — {activeTurnBudget.cardsThisTurn} of {activeTurnBudget.cap} card{activeTurnBudget.cap ===
				1
					? ''
					: 's'} played this turn{activeTurnBudget.actionTaken ? ' (action taken)' : ''}
			</p>
		{/if}

		{#if challenge}
			<TurnControls {role} genericProjection={session.projection as SessionPlayerProjection | SessionGmProjection} {challenge} {legalCommands} {actionRunner} />
		{/if}

		{#if role === 'gm'}
			<GmChallengeControls
				genericProjection={session.projection as SessionGmProjection}
				challenge={challenge as ChallengeGmProjection | null}
				{legalCommands}
				roster={challengeRoster}
				{enemyThreatOptions}
				{actionRunner}
			/>
		{/if}

		{#if challenge}
			<ModifierControls
				{role}
				{userId}
				genericProjection={session.projection as SessionPlayerProjection | SessionGmProjection}
				{challenge}
				{legalCommands}
				roster={challengeRoster}
				{actionRunner}
			/>
		{/if}
	</section>
{/if}

<style>
	.challenge-panel {
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
		padding: 1rem;
		border: 1px solid color-mix(in oklab, var(--accent) 45%, transparent);
	}
	.challenge-header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
		/* Reduced-motion-respecting stage transition (Step 3): a brief
		 * highlight when the stage line changes, disabled entirely under
		 * `prefers-reduced-motion: reduce`. */
		animation: stage-settle 400ms ease-out;
	}
	@media (prefers-reduced-motion: reduce) {
		.challenge-header {
			animation: none;
		}
	}
	@keyframes stage-settle {
		from {
			opacity: 0.4;
		}
		to {
			opacity: 1;
		}
	}
	h2 {
		margin: 0;
		font-size: 1.05rem;
	}
	.stage {
		margin: 0;
		font-family: var(--font-subhead);
		color: var(--ink-soft);
	}
	.turn-budget {
		margin: 0;
		font-size: 0.85rem;
		color: var(--ink-soft);
	}
	.initiative-order {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
</style>
