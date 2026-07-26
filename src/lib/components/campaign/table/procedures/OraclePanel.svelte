<script lang="ts">
	/**
	 * The finite-runner panel (Increment 4 Task 4). One generic step UI serves
	 * every data-driven procedure — which procedures it OFFERS is the `phases`
	 * prop, so `OraclePanel` (oracle/City/cross-phase) and `CrawlProcedurePanel`
	 * (crawl/camp) are two placements of the same machinery. Presentation only:
	 * every control renders from `session.finiteLegalCommands` and the
	 * projection's own `currentStep.needs`.
	 */
	import { createFiniteAction } from './finite-action.svelte';
	import type { ActiveChallengeTenureView } from '$lib/server/campaign/page-data';
	import type { FiniteCommandInput } from '$lib/schemas/finite-command.schema';
	import type { SendCommandResult, TableSession } from '$lib/stores/campaign-session.svelte';

	let {
		role,
		userId,
		session,
		roster,
		phases = ['cross-phase', 'city'],
		heading = 'Oracles & City',
		procedureTitles,
		onSendFiniteCommand
	}: {
		role: 'gm' | 'player';
		userId: string;
		session: TableSession;
		roster: ActiveChallengeTenureView[];
		/** Which content-pack phases this placement offers to begin. */
		phases?: string[];
		heading?: string;
		/** id -> {title, phase} for the begin picker, supplied by the page from
		 * the same pinned content the server resolves against. */
		procedureTitles: Array<{ id: string; title: string; phase: string }>;
		onSendFiniteCommand: (command: FiniteCommandInput, commandId?: string) => Promise<SendCommandResult>;
	} = $props();

	const actionRunner = createFiniteAction((command, commandId) => onSendFiniteCommand(command, commandId));

	const finite = $derived(session.finiteProjection);
	const running = $derived(finite?.procedure ?? null);
	const controls = $derived(session.finiteLegalCommands);
	const offered = $derived(
		(finite?.beginnable ?? [])
			.map((id) => procedureTitles.find((candidate) => candidate.id === id))
			.filter((entry): entry is { id: string; title: string; phase: string } => entry !== undefined && phases.includes(entry.phase))
	);
	/** This placement renders a RUNNING procedure only if it belongs to its
	 * phases, so the crawl and oracle placements never double-render one. */
	const runningHere = $derived(
		running !== null && phases.includes(procedureTitles.find((candidate) => candidate.id === running.procedureId)?.phase ?? '')
	);
	const visible = $derived(runningHere || (controls.includes('begin-finite-procedure') && offered.length > 0));

	let chosenProcedureId = $state('');
	let chosenActorTenureId = $state('');
	let chosenOption = $state('');
	let chosenMode = $state<'appropriate-realm' | 'random-realm'>('appropriate-realm');
	let chosenRealmTableId = $state('');
	/** The order the player is building for a reorder-top step. */
	let reorderPicks = $state<string[]>([]);

	/** What the selected procedure needs supplied at begin time — from content,
	 * never a hardcoded procedure id. */
	const requirement = $derived(finite?.beginRequirements.find((entry) => entry.procedureId === chosenProcedureId) ?? null);
	/** A player acts as their OWN adventurer — the roster entry matching them.
	 * Without this a player's begin request omitted `actorTenureId` entirely and
	 * was rejected (second-pass review). */
	const myTenureId = $derived(roster.find((entry) => entry.userId === userId)?.tenureId ?? '');
	/** The actor the begin request will name: the GM's pick, or the player's own. */
	const effectiveActorTenureId = $derived(role === 'gm' ? chosenActorTenureId : myTenureId);
	/** A procedure with player steps MUST name an actor, or nobody can advance
	 * it once begun. */
	const beginBlocked = $derived(
		!chosenProcedureId ||
			(requirement?.requiresMode && chosenMode === 'appropriate-realm' && !chosenRealmTableId) ||
			(requirement?.needsActor === true && !effectiveActorTenureId)
	);

	function begin(): void {
		if (!chosenProcedureId) return;
		if (beginBlocked) return;
		void actionRunner.run({
			type: 'begin-finite-procedure',
			procedureId: chosenProcedureId,
			...(effectiveActorTenureId ? { actorTenureId: effectiveActorTenureId } : {}),
			// Maleficence and anything else with invocation-mode conditions: without
			// these, neither mode-gated step is applicable and the procedure would
			// complete having done nothing (review finding).
			...(requirement?.requiresMode ? { mode: chosenMode } : {}),
			...(requirement?.requiresMode && chosenMode === 'appropriate-realm' && chosenRealmTableId
				? { realmTableId: chosenRealmTableId }
				: {})
		});
	}

	const step = $derived(running?.currentStep ?? null);

	function advance(answer?: 'yes' | 'no', stepId?: string): void {
		if (!step) return;
		if (step.needs === 'confirm') {
			// Both answers must be reachable — a flat-50% gate that can only say
			// "yes" is not a 50% gate (review finding).
			return void actionRunner.run({
				type: 'advance-finite-procedure',
				confirm: answer ?? 'yes',
				...(stepId ? { stepId } : {})
			});
		}
		if (step.needs === 'chosen-card') {
			if (!chosenOption) return;
			return void actionRunner.run({ type: 'advance-finite-procedure', chosenCardId: chosenOption });
		}
		if (step.needs === 'ordered-cards') {
			if (reorderPicks.length !== step.reorderCount) return;
			const order = reorderPicks.slice();
			reorderPicks = [];
			return void actionRunner.run({ type: 'advance-finite-procedure', orderedCardIds: order });
		}
		void actionRunner.run({ type: 'advance-finite-procedure', ...(stepId ? { stepId } : {}) });
	}

	function togglePick(cardId: string): void {
		reorderPicks = reorderPicks.includes(cardId) ? reorderPicks.filter((id) => id !== cardId) : [...reorderPicks, cardId];
	}

	function labelForStepId(stepId: string): string {
		return stepId.replaceAll('-', ' ');
	}

	function nameFor(tenureId: string | null): string {
		if (!tenureId) return '';
		return roster.find((entry) => entry.tenureId === tenureId)?.characterName ?? tenureId;
	}
</script>

{#if visible}
	<section class="finite-panel" data-testid={`finite-panel-${phases[0]}`} aria-label={heading}>
		<header>
			<h2>{heading}</h2>
			{#if runningHere && running}
				<p class="stage" data-testid="finite-title">{running.title}{running.actorTenureId ? ` — ${nameFor(running.actorTenureId)}` : ''}</p>
			{/if}
		</header>

		{#if runningHere && running}
			{#each running.outcomes as entry (entry.stepId)}
				<div class="outcome" data-testid={`finite-outcome-${entry.stepId}`}>
					{#each entry.outcome.cells as cell, index (index)}
						<p class="cell">
							{cell.resolvedText}
							{#if cell.activeBranches.length > 0}<span class="branches">({cell.activeBranches.join(', ')})</span>{/if}
						</p>
						{#each cell.references as reference (reference.entryId)}
							<a class="reference" href={reference.collection === 'denizens' ? `/denizens#${reference.entryId}` : `/rules#${reference.entryId}`}
								>{reference.label}</a
							>
						{/each}
					{/each}
					<p class="manual-note">The GM adjudicates the consequence — the app supplies the rule text.</p>
				</div>
			{/each}

			{#if running.peekTop.length > 0}
				<div class="peek" data-testid="finite-peek">
					<p>Top of the deck (yours alone to see):</p>
					<ol>
						{#each running.peekTop as slot, index (index)}
							{#if !slot.hidden}<li>{slot.label}</li>{/if}
						{/each}
					</ol>
				</div>
			{/if}

			{#if controls.includes('advance-finite-procedure') && step}
				{#if step.needs === 'chosen-card'}
					<div class="controls">
						<select bind:value={chosenOption} data-testid="finite-option">
							<option value="">Choose…</option>
							{#each step.options as option (option)}
								<option value={option}>{option}</option>
							{/each}
						</select>
						<button type="button" onclick={() => advance()} disabled={actionRunner.pending || !chosenOption} data-testid="finite-advance"
							>Choose</button
						>
					</div>
				{:else if step.needs === 'ordered-cards'}
					<!-- As Above, So Below: click the peeked cards in the order you want
					     them back on the deck. -->
					<fieldset class="controls">
						<legend>Put them back in this order (click in sequence)</legend>
						{#each running.peekTop as slot, index (index)}
							{#if !slot.hidden}
								<button
									type="button"
									class:picked={reorderPicks.includes(slot.id)}
									onclick={() => togglePick(slot.id)}
									data-testid={`reorder-pick-${slot.id}`}
								>
									{reorderPicks.indexOf(slot.id) >= 0 ? `${reorderPicks.indexOf(slot.id) + 1}. ` : ''}{slot.label}
								</button>
							{/if}
						{/each}
						<button
							type="button"
							onclick={() => advance()}
							disabled={actionRunner.pending || reorderPicks.length !== step.reorderCount}
							data-testid="finite-advance">Set the order</button
						>
					</fieldset>
				{:else if step.forkStepIds.length > 1}
					<!-- A fork (Augury accept/decline): every branch is reachable. -->
					<div class="controls">
						{#each step.forkStepIds as forkId (forkId)}
							<button
								type="button"
								onclick={() => advance('yes', forkId)}
								disabled={actionRunner.pending}
								data-testid={`finite-fork-${forkId}`}>{labelForStepId(forkId)}</button
							>
						{/each}
					</div>
				{:else if step.needs === 'confirm'}
					<div class="controls">
						<button type="button" onclick={() => advance('yes')} disabled={actionRunner.pending} data-testid="finite-advance">Yes</button>
						<button type="button" onclick={() => advance('no')} disabled={actionRunner.pending} data-testid="finite-decline">No</button>
					</div>
				{:else}
					<button type="button" onclick={() => advance()} disabled={actionRunner.pending} data-testid="finite-advance">
						{step.operation === 'draw' ? 'Draw' : 'Continue'}
					</button>
				{/if}
			{/if}

			{#if controls.includes('complete-finite-procedure')}
				<button
					type="button"
					onclick={() => actionRunner.run({ type: 'complete-finite-procedure' })}
					disabled={actionRunner.pending}
					data-testid="finite-complete">Finish</button
				>
			{/if}
		{:else if offered.length > 0 && controls.includes('begin-finite-procedure')}
			<div class="controls">
				<select bind:value={chosenProcedureId} data-testid="finite-procedure-picker">
					<option value="">Choose a procedure…</option>
					{#each offered as entry (entry.id)}
						<option value={entry.id}>{entry.title}</option>
					{/each}
				</select>
				{#if role === 'gm' && requirement?.needsActor !== false}
					<select bind:value={chosenActorTenureId} data-testid="finite-actor-picker">
						<option value="">{requirement?.needsActor ? 'Choose the acting adventurer…' : 'No acting adventurer'}</option>
						{#each roster as entry (entry.tenureId)}
							<option value={entry.tenureId}>{entry.characterName}</option>
						{/each}
					</select>
				{/if}
				{#if requirement?.requiresMode}
					<select bind:value={chosenMode} data-testid="finite-mode-picker">
						<option value="appropriate-realm">Cast into the appropriate realm</option>
						<option value="random-realm">Cast into a random realm</option>
					</select>
					{#if chosenMode === 'appropriate-realm'}
						<select bind:value={chosenRealmTableId} data-testid="finite-realm-picker">
							<option value="">Choose the realm…</option>
							{#each requirement.realmTableIds as tableId (tableId)}
								<option value={tableId}>{tableId.replace('maleficence-', '')}</option>
							{/each}
						</select>
					{/if}
				{/if}
				<button
					type="button"
					onclick={begin}
					disabled={actionRunner.pending || beginBlocked}
					data-testid="finite-begin">Begin</button
				>
			</div>
		{/if}

		{#if actionRunner.error}
			<p class="error" role="alert" data-testid="finite-error">{actionRunner.error}</p>
		{/if}
	</section>
{/if}

<style>
	.finite-panel {
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
		padding: 1rem;
		border: 1px solid color-mix(in oklab, var(--accent) 45%, transparent);
	}
	header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
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
	.outcome {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	.cell,
	.manual-note,
	.peek p {
		margin: 0;
		font-size: 0.9rem;
	}
	.branches,
	.manual-note {
		color: var(--ink-soft);
	}
	.reference {
		font-size: 0.85rem;
	}
	.peek ol {
		margin: 0;
		padding-left: 1.2rem;
		font-size: 0.9rem;
	}
	.controls {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}
	.picked {
		border-color: var(--accent);
		font-weight: 600;
	}
	.error {
		margin: 0;
		font-size: 0.9rem;
		color: var(--danger, crimson);
	}
</style>
