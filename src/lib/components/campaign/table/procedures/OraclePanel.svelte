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
		session,
		roster,
		phases = ['cross-phase', 'city'],
		heading = 'Oracles & City',
		procedureTitles,
		onSendFiniteCommand
	}: {
		role: 'gm' | 'player';
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

	function begin(): void {
		if (!chosenProcedureId) return;
		void actionRunner.run({
			type: 'begin-finite-procedure',
			procedureId: chosenProcedureId,
			...(chosenActorTenureId ? { actorTenureId: chosenActorTenureId } : {})
		});
	}

	const step = $derived(running?.currentStep ?? null);

	function advance(): void {
		if (!step) return;
		if (step.needs === 'confirm') return void actionRunner.run({ type: 'advance-finite-procedure', confirm: 'yes' });
		if (step.needs === 'chosen-card') {
			if (!chosenOption) return;
			return void actionRunner.run({ type: 'advance-finite-procedure', chosenCardId: chosenOption });
		}
		void actionRunner.run({ type: 'advance-finite-procedure' });
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
						<button type="button" onclick={advance} disabled={actionRunner.pending || !chosenOption} data-testid="finite-advance">Choose</button>
					</div>
				{:else}
					<button type="button" onclick={advance} disabled={actionRunner.pending} data-testid="finite-advance">
						{step.needs === 'confirm' ? 'Confirm' : step.operation === 'draw' ? 'Draw' : 'Continue'}
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
				{#if role === 'gm'}
					<select bind:value={chosenActorTenureId} data-testid="finite-actor-picker">
						<option value="">No acting adventurer</option>
						{#each roster as entry (entry.tenureId)}
							<option value={entry.tenureId}>{entry.characterName}</option>
						{/each}
					</select>
				{/if}
				<button type="button" onclick={begin} disabled={actionRunner.pending || !chosenProcedureId} data-testid="finite-begin">Begin</button>
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
	.error {
		margin: 0;
		font-size: 0.9rem;
		color: var(--danger, crimson);
	}
</style>
