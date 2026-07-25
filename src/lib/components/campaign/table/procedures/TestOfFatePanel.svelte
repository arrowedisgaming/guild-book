<script lang="ts">
	/**
	 * The guided test-of-fate panel (Increment 4 Task 2 Step 4). Presentation +
	 * composition only: every mutation goes through the shared `actionRunner`,
	 * and nothing here computes legality. Which controls exist comes entirely
	 * from `session.guidedTestLegalCommands` — including whether the Resolve
	 * purchase is affordable, which the server already decided.
	 *
	 * The GM declares the fictional test (who and which suit) and settles
	 * favor/disfavor; the acting player buys favor, draws, and chooses whether to
	 * push. That split is the rules': Ch1 puts the call in the GM's hands ("the
	 * GM can call for a test of fate") and the push in the player's ("the player
	 * may opt to push fate").
	 *
	 * `role`/`userId` are used ONLY to pick which half of the panel to render.
	 * Authorization is the server's; `isMine` on the projection is what marks the
	 * acting player, resolved server-side through tenure ownership rather than by
	 * comparing ids here.
	 */
	import { createGuidedTestAction } from './guided-test-action.svelte';
	import { SUIT_IDS, SUIT_LABELS, type SuitId } from '$lib/types/common';
	import type { ActiveChallengeTenureView } from '$lib/server/campaign/page-data';
	import type { GuidedTestCommand } from '$lib/engine/session/procedures/guided-test-command';
	import type { ResolveReconfirmation, SendCommandResult, TableSession } from '$lib/stores/campaign-session.svelte';

	let {
		role,
		session,
		roster,
		embedded = false,
		onSendGuidedTestCommand
	}: {
		role: 'gm' | 'player';
		session: TableSession;
		roster: ActiveChallengeTenureView[];
		/**
		 * True when `GroupTestPanel` is rendering this panel as one of a group
		 * test's two subtests. Standalone, this panel hides itself during a group
		 * test (the group owns the flow) and offers the GM the "call for a test"
		 * affordance; embedded, it does neither — it renders the open subtest and
		 * nothing else. Without this flag the nested instance would apply the same
		 * hide-during-a-group rule to itself and render nothing at all.
		 */
		embedded?: boolean;
		onSendGuidedTestCommand: (
			command: GuidedTestCommand,
			commandId?: string,
			reconfirmation?: ResolveReconfirmation
		) => Promise<SendCommandResult>;
	} = $props();

	// Wrapped in a closure so the runner always calls the CURRENT prop value,
	// not the one captured at mount (`state_referenced_locally`).
	const actionRunner = createGuidedTestAction((command, commandId, reconfirmation) =>
		onSendGuidedTestCommand(command, commandId, reconfirmation)
	);

	const guided = $derived(session.guidedTestProjection);
	const test = $derived(guided?.test ?? null);
	const controls = $derived(session.guidedTestLegalCommands);
	/** A group test owns its own panel; this one renders only a standalone test
	 * (and the GM's affordance to call for one). */
	const inGroup = $derived((guided?.group ?? null) !== null && guided?.group?.stage !== 'complete');
	const visible = $derived(embedded ? test !== null : !inGroup && (test !== null || controls.includes('declare-test-of-fate')));

	const STAGE_LABELS: Record<string, string> = {
		favor: 'Settling favor',
		'initial-draw': 'Ready to draw',
		'push-offer': 'Push fate?',
		complete: 'Resolved'
	};

	function nameFor(tenureId: string): string {
		return roster.find((entry) => entry.tenureId === tenureId)?.characterName ?? tenureId;
	}

	function suitLabel(suit: SuitId): string {
		return SUIT_LABELS[suit] ?? suit;
	}

	// --- GM declaration form -------------------------------------------------
	let declareTenureId = $state('');
	let declareSuit = $state<SuitId>('swords');
	let favor = $state(false);
	let disfavor = $state(false);

	const declarableRoster = $derived(roster);

	function declare(): void {
		if (!declareTenureId) return;
		void actionRunner.run({ type: 'declare-test-of-fate', actorTenureId: declareTenureId, testedSuit: declareSuit });
	}

	function settleFavor(): void {
		void actionRunner.run({ type: 'set-test-favor', favor, disfavor });
	}

	/** Sends the pair the server requires, both read from the SAME projection so
	 * they describe one moment. A refused purchase refreshes the projection, so
	 * the next click sends the new numbers — the reconfirmation contract. */
	function buyFavor(): void {
		if (test?.characterVersion === null || test?.characterVersion === undefined) return;
		if (test.resolveCurrent === null) return;
		void actionRunner.run(
			{ type: 'purchase-test-favor' },
			{ observedCharacterVersion: test.characterVersion, expectedResolveCurrent: test.resolveCurrent }
		);
	}

	/** Announced to assistive tech on every public change. A test of fate is
	 * public by rule, so nothing here is a disclosure the table cannot already
	 * see. */
	const announcement = $derived.by(() => {
		if (!test) return '';
		const who = nameFor(test.actorTenureId);
		if (test.result) {
			const pushed = test.result.pushed ? ' after pushing fate' : '';
			return `${who} totalled ${test.result.total} testing ${suitLabel(test.testedSuit)} — ${test.result.outcomeLabel}${pushed}.`;
		}
		if (test.stage === 'initial-draw') return `${who} is ready to test ${suitLabel(test.testedSuit)}.`;
		return `${who} will test ${suitLabel(test.testedSuit)}.`;
	});
</script>

{#if visible}
	<section class="test-panel" data-testid="test-of-fate-panel" aria-label="Test of fate">
		<header>
			<h2>Test of Fate</h2>
			{#if test}
				<p class="stage" data-testid="test-stage">{STAGE_LABELS[test.stage] ?? test.stage}</p>
			{/if}
		</header>

		<p class="sr-only" role="status" aria-live="polite" data-testid="test-announcement">{announcement}</p>

		{#if test}
			<dl class="facts">
				<dt>Testing</dt>
				<dd data-testid="test-actor">{nameFor(test.actorTenureId)}</dd>
				<dt>Attribute</dt>
				<dd data-testid="test-suit">{suitLabel(test.testedSuit)}</dd>
				{#if test.favor || test.disfavor || test.resolveSpent}
					<dt>Modifier</dt>
					<dd data-testid="test-modifier">
						{#if test.favor}Favor{/if}
						{#if test.resolveSpent}{test.favor ? ', ' : ''}Favor (Resolve){/if}
						{#if test.disfavor}{test.favor || test.resolveSpent ? ', ' : ''}Disfavor{/if}
					</dd>
				{/if}
			</dl>

			{#if test.initialCard && !test.initialCard.hidden}
				<p class="card" data-testid="test-initial-card">Drew {test.initialCard.label}</p>
			{/if}
			{#if test.pushCard && !test.pushCard.hidden}
				<p class="card" data-testid="test-push-card">Pushed into {test.pushCard.label}</p>
			{/if}

			{#if test.result}
				<p class="outcome" data-testid="test-outcome">
					Total {test.result.total} — <strong>{test.result.outcomeLabel}</strong>
					{#if test.result.foolDrawn}<span class="fool"> (the Fool — both decks reshuffle)</span>{/if}
				</p>
			{/if}
		{/if}

		{#if role === 'gm' && !embedded && !test && controls.includes('declare-test-of-fate')}
			<div class="controls">
				<label>
					Adventurer
					<select bind:value={declareTenureId} data-testid="declare-test-tenure">
						<option value="">Choose…</option>
						{#each declarableRoster as entry (entry.tenureId)}
							<option value={entry.tenureId}>{entry.characterName}</option>
						{/each}
					</select>
				</label>
				<label>
					Attribute
					<select bind:value={declareSuit} data-testid="declare-test-suit">
						{#each SUIT_IDS as suit (suit)}
							<option value={suit}>{suitLabel(suit)}</option>
						{/each}
					</select>
				</label>
				<button type="button" onclick={declare} disabled={actionRunner.pending || !declareTenureId} data-testid="declare-test">
					Call for a test of fate
				</button>
			</div>
		{/if}

		{#if controls.includes('set-test-favor')}
			<div class="controls">
				<label><input type="checkbox" bind:checked={favor} data-testid="test-favor-toggle" /> Favor</label>
				<label><input type="checkbox" bind:checked={disfavor} data-testid="test-disfavor-toggle" /> Disfavor</label>
				<button type="button" onclick={settleFavor} disabled={actionRunner.pending} data-testid="settle-favor">Settle and continue</button>
			</div>
		{/if}

		{#if controls.includes('purchase-test-favor')}
			<button type="button" onclick={buyFavor} disabled={actionRunner.pending} data-testid="buy-favor">
				Spend 1 Resolve for favor{test?.resolveCurrent !== null && test?.resolveCurrent !== undefined ? ` (${test.resolveCurrent} left)` : ''}
			</button>
		{:else if test?.isMine && test.stage === 'initial-draw' && test.resolveAffordable === false}
			<p class="hint" data-testid="no-resolve-hint">No Resolve left to buy favor.</p>
		{/if}

		{#if controls.includes('draw-test-card')}
			<button
				type="button"
				onclick={() => actionRunner.run({ type: 'draw-test-card' })}
				disabled={actionRunner.pending}
				data-testid="draw-test-card">Draw</button
			>
		{/if}

		{#if controls.includes('push-test-fate')}
			<div class="controls">
				<button
					type="button"
					onclick={() => actionRunner.run({ type: 'push-test-fate' })}
					disabled={actionRunner.pending}
					data-testid="push-fate">Push fate (free)</button
				>
				<button
					type="button"
					onclick={() => actionRunner.run({ type: 'decline-test-push' })}
					disabled={actionRunner.pending}
					data-testid="decline-push">Accept the failure</button
				>
			</div>
		{/if}

		{#if controls.includes('complete-guided-test')}
			<button
				type="button"
				onclick={() => actionRunner.run({ type: 'complete-guided-test' })}
				disabled={actionRunner.pending}
				data-testid="complete-test">Finish the test</button
			>
		{/if}

		{#if actionRunner.error}
			<p class="error" role="alert" data-testid="test-error">{actionRunner.error}</p>
		{/if}
	</section>
{/if}

<style>
	.test-panel {
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
	.card,
	.outcome,
	.hint {
		margin: 0;
		font-size: 0.9rem;
	}
	.hint,
	.fool {
		color: var(--ink-soft);
	}
	.controls {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
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
