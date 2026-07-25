<script lang="ts">
	/**
	 * The guided group-test panel (Increment 4 Task 2 Step 4) — Ch1 "Group tests".
	 *
	 * A group test IS two complete tests of fate, so this panel owns only what is
	 * genuinely group-level: who was chosen, the tie the table may need to talk
	 * out, the running hit total, and the final band. Each subtest is rendered by
	 * `TestOfFatePanel` — the same component, driving the same commands, because
	 * it is the same procedure underneath.
	 *
	 * Nothing here computes legality or hits: controls come from
	 * `session.guidedTestLegalCommands`, and the hit total and band come from the
	 * server's `resolveGroupTest`.
	 */
	import { createGuidedTestAction } from './guided-test-action.svelte';
	import TestOfFatePanel from './TestOfFatePanel.svelte';
	import { SUIT_IDS, SUIT_LABELS, type SuitId } from '$lib/types/common';
	import type { ActiveChallengeTenureView } from '$lib/server/campaign/page-data';
	import type { GuidedTestCommand } from '$lib/engine/session/procedures/guided-test-command';
	import type { ResolveReconfirmation, SendCommandResult, TableSession } from '$lib/stores/campaign-session.svelte';

	let {
		role,
		session,
		roster,
		onSendGuidedTestCommand
	}: {
		role: 'gm' | 'player';
		session: TableSession;
		roster: ActiveChallengeTenureView[];
		onSendGuidedTestCommand: (
			command: GuidedTestCommand,
			commandId?: string,
			reconfirmation?: ResolveReconfirmation
		) => Promise<SendCommandResult>;
	} = $props();

	const actionRunner = createGuidedTestAction((command, commandId, reconfirmation) =>
		onSendGuidedTestCommand(command, commandId, reconfirmation)
	);

	const guided = $derived(session.guidedTestProjection);
	const group = $derived(guided?.group ?? null);
	const controls = $derived(session.guidedTestLegalCommands);
	const visible = $derived(group !== null || controls.includes('declare-group-test'));

	const STAGE_LABELS: Record<string, string> = {
		'most-qualified': 'The most qualified adventurer tests',
		'least-qualified': 'The least qualified adventurer tests',
		complete: 'Resolved'
	};

	function nameFor(tenureId: string): string {
		return roster.find((entry) => entry.tenureId === tenureId)?.characterName ?? tenureId;
	}

	function suitLabel(suit: SuitId): string {
		return SUIT_LABELS[suit] ?? suit;
	}

	// --- GM declaration form -------------------------------------------------
	let declareSuit = $state<SuitId>('swords');
	let selected = $state<string[]>([]);
	let overrideMost = $state('');
	let overrideLeast = $state('');

	function toggleCandidate(tenureId: string): void {
		selected = selected.includes(tenureId) ? selected.filter((id) => id !== tenureId) : [...selected, tenureId];
	}

	function declare(): void {
		if (selected.length < 2) return;
		void actionRunner.run({ type: 'declare-group-test', testedSuit: declareSuit, candidateTenureIds: selected });
	}

	function applyOverride(): void {
		if (!overrideMost || !overrideLeast || overrideMost === overrideLeast) return;
		void actionRunner.run({
			type: 'override-group-test-actors',
			mostQualifiedTenureId: overrideMost,
			leastQualifiedTenureId: overrideLeast
		});
	}

	const announcement = $derived.by(() => {
		if (!group) return '';
		if (group.result) {
			return `Group test complete — ${group.result.hits} hit${group.result.hits === 1 ? '' : 's'}: ${group.result.outcome.label}.`;
		}
		const most = nameFor(group.mostQualifiedTenureId);
		const least = nameFor(group.leastQualifiedTenureId);
		const tie = group.requiresTableDecision ? ' The table may talk out the tie.' : '';
		return `Group test of ${suitLabel(group.testedSuit)}: ${most} and ${least} will test.${tie}`;
	});
</script>

{#if visible}
	<section class="group-panel" data-testid="group-test-panel" aria-label="Group test">
		<header>
			<h2>Group Test</h2>
			{#if group}
				<p class="stage" data-testid="group-stage">{STAGE_LABELS[group.stage] ?? group.stage}</p>
			{/if}
		</header>

		<p class="sr-only" role="status" aria-live="polite" data-testid="group-announcement">{announcement}</p>

		{#if group}
			<dl class="facts">
				<dt>Attribute</dt>
				<dd data-testid="group-suit">{suitLabel(group.testedSuit)}</dd>
				<dt>Most qualified</dt>
				<dd data-testid="group-most">{nameFor(group.mostQualifiedTenureId)}</dd>
				<dt>Least qualified</dt>
				<dd data-testid="group-least">{nameFor(group.leastQualifiedTenureId)}</dd>
			</dl>

			{#if group.requiresTableDecision && group.stage !== 'complete'}
				<p class="hint" data-testid="group-tie-hint">
					Attributes are tied — the book leaves this to the table. The proposal above is a stable default the GM may change.
				</p>
			{/if}

			{#if group.subtestSummaries.length > 0}
				<ol class="subtests" aria-label="Completed tests" data-testid="group-subtests">
					{#each group.subtestSummaries as summary, index (index)}
						<li>
							{nameFor(summary.actorTenureId)} — {summary.total}
							{#if summary.pushed}(pushed){/if}
							{#if summary.favor}(favor){/if}
							{#if summary.resolveSpent}(Resolve){/if}
							{#if summary.disfavor}(disfavor){/if}
							— {summary.outcome}
						</li>
					{/each}
				</ol>
			{/if}

			{#if group.result}
				<p class="outcome" data-testid="group-outcome">
					{group.result.hits} hit{group.result.hits === 1 ? '' : 's'} — <strong>{group.result.outcome.label}</strong>
				</p>
				{#if group.result.outcome.description}
					<p class="hint">{group.result.outcome.description}</p>
				{/if}
			{/if}
		{/if}

		{#if role === 'gm' && controls.includes('declare-group-test')}
			<fieldset class="controls">
				<legend>Call for a group test</legend>
				<label>
					Attribute
					<select bind:value={declareSuit} data-testid="declare-group-suit">
						{#each SUIT_IDS as suit (suit)}
							<option value={suit}>{suitLabel(suit)}</option>
						{/each}
					</select>
				</label>
				{#each roster as entry (entry.tenureId)}
					<label>
						<input
							type="checkbox"
							checked={selected.includes(entry.tenureId)}
							onchange={() => toggleCandidate(entry.tenureId)}
							data-testid={`group-candidate-${entry.tenureId}`}
						/>
						{entry.characterName}
					</label>
				{/each}
				<button type="button" onclick={declare} disabled={actionRunner.pending || selected.length < 2} data-testid="declare-group-test">
					Call for a group test
				</button>
			</fieldset>
		{/if}

		{#if controls.includes('override-group-test-actors') && group}
			<fieldset class="controls">
				<legend>Record the table’s decision</legend>
				<label>
					Most qualified
					<select bind:value={overrideMost} data-testid="override-most">
						<option value="">Choose…</option>
						{#each group.candidateTenureIds as tenureId (tenureId)}
							<option value={tenureId}>{nameFor(tenureId)}</option>
						{/each}
					</select>
				</label>
				<label>
					Least qualified
					<select bind:value={overrideLeast} data-testid="override-least">
						<option value="">Choose…</option>
						{#each group.candidateTenureIds as tenureId (tenureId)}
							<option value={tenureId}>{nameFor(tenureId)}</option>
						{/each}
					</select>
				</label>
				<button
					type="button"
					onclick={applyOverride}
					disabled={actionRunner.pending || !overrideMost || !overrideLeast || overrideMost === overrideLeast}
					data-testid="apply-override">Use these two</button
				>
			</fieldset>
		{/if}

		<!-- The open subtest is an ordinary test of fate, rendered by the ordinary
		     test panel. Only the group's own advance replaces its completion. -->
		{#if guided?.test}
			<TestOfFatePanel {role} {session} {roster} embedded {onSendGuidedTestCommand} />
		{/if}

		{#if controls.includes('advance-group-test')}
			<button
				type="button"
				onclick={() => actionRunner.run({ type: 'advance-group-test' })}
				disabled={actionRunner.pending}
				data-testid="advance-group-test"
			>
				{group?.stage === 'most-qualified' ? 'Score it and pass to the next adventurer' : 'Score the group test'}
			</button>
		{/if}

		{#if actionRunner.error}
			<p class="error" role="alert" data-testid="group-error">{actionRunner.error}</p>
		{/if}
	</section>
{/if}

<style>
	.group-panel {
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
	.facts {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 0.15rem 0.6rem;
		margin: 0;
		font-size: 0.9rem;
	}
	.facts dt {
		color: var(--ink-soft);
	}
	.facts dd {
		margin: 0;
	}
	.subtests {
		margin: 0;
		padding-left: 1.2rem;
		font-size: 0.9rem;
	}
	.outcome,
	.hint {
		margin: 0;
		font-size: 0.9rem;
	}
	.hint {
		color: var(--ink-soft);
	}
	.controls {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		border: 1px solid color-mix(in oklab, var(--accent) 25%, transparent);
		padding: 0.5rem 0.7rem;
	}
	.controls legend {
		font-family: var(--font-subhead);
		font-size: 0.85rem;
		padding: 0 0.3rem;
	}
	.controls label {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.9rem;
	}
	.error {
		margin: 0;
		font-size: 0.9rem;
		color: var(--danger, crimson);
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
