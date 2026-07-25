<script lang="ts">
	/**
	 * The Camp procedures panel (Increment 4 Task 3) — High Chant and leeches.
	 *
	 * Presentation and composition only. Every control renders from
	 * `session.campLegalCommands`, computed server-side; nothing here decides
	 * legality, counts an allowance, or classifies a suit.
	 *
	 * The privacy discipline matters in the markup, not just the engine: this
	 * panel renders the viewer's OWN inspiration card face and every other
	 * adventurer's inspiration COUNT. There is no branch anywhere below that could
	 * show another player's face, because the projection never carries one.
	 */
	import { createCampAction } from './camp-action.svelte';
	import { SUIT_LABELS, type SuitId } from '$lib/types/common';
	import type { ActiveChallengeTenureView } from '$lib/server/campaign/page-data';
	import type { CampProcedureCommand } from '$lib/engine/session/procedures/camp-command';
	import type { SendCommandResult, TableSession } from '$lib/stores/campaign-session.svelte';

	let {
		role,
		session,
		roster,
		onSendCampCommand
	}: {
		role: 'gm' | 'player';
		session: TableSession;
		roster: ActiveChallengeTenureView[];
		onSendCampCommand: (command: CampProcedureCommand, commandId?: string) => Promise<SendCommandResult>;
	} = $props();

	const actionRunner = createCampAction((command, commandId) => onSendCampCommand(command, commandId));

	const camp = $derived(session.campProjection);
	const controls = $derived(session.campLegalCommands);
	const highChant = $derived(camp?.highChant ?? null);
	const leeches = $derived(camp?.leeches ?? null);
	const visible = $derived(
		highChant !== null || leeches !== null || controls.includes('begin-high-chant') || (camp?.inspiration.some((entry) => entry.count > 0) ?? false)
	);

	function nameFor(tenureId: string): string {
		return roster.find((entry) => entry.tenureId === tenureId)?.characterName ?? tenureId;
	}

	function suitList(suits: SuitId[]): string {
		return suits.map((suit) => SUIT_LABELS[suit] ?? suit).join(' or ');
	}

	// --- High Chant selection form ------------------------------------------
	let picked = $state<string[]>([]);
	let recipientTenureId = $state('');
	let selectedCardId = $state('');
	let leechTarget = $state('');

	/** The full minor discard, surfaced by the Camp projection only while a High
	 * Chant is selecting — Ch5 lets the performer pick any cards from the pile, so
	 * the generic projection's top-card-only view could never reach the second
	 * one. See `CampProjection.minorDiscard`. */
	const discardChoices = $derived(camp?.minorDiscard ?? []);

	function togglePick(cardId: string): void {
		picked = picked.includes(cardId) ? picked.filter((id) => id !== cardId) : [...picked, cardId];
	}

	function submitSelection(): void {
		if (picked.length === 0) return;
		void actionRunner.run({ type: 'select-inspiration', cardIds: picked });
		picked = [];
	}

	function handOver(): void {
		if (!selectedCardId || !recipientTenureId) return;
		void actionRunner.run({
			type: 'complete-high-chant-transfer',
			cardId: selectedCardId,
			recipientTenureId
		});
		selectedCardId = '';
		recipientTenureId = '';
	}

	function applyLeeches(): void {
		if (!leechTarget) return;
		void actionRunner.run({ type: 'begin-leeches', targetTenureId: leechTarget });
		leechTarget = '';
	}

	const announcement = $derived.by(() => {
		if (leeches?.outcome) {
			const who = nameFor(leeches.targetTenureId);
			return leeches.outcome.effect === 'cure-affliction'
				? `Leeches on ${who}: counts as burning ${leeches.outcome.charges} charges to cure an affliction. Apply it on the sheet.`
				: `Leeches on ${who}: nothing happens.`;
		}
		if (leeches) return `${nameFor(leeches.actorTenureId)} is applying leeches to ${nameFor(leeches.targetTenureId)}.`;
		if (highChant) {
			return highChant.stage === 'select'
				? `${nameFor(highChant.performerTenureId)} performs the High Chant — ${highChant.allowance} inspiration card(s) to select.`
				: `${nameFor(highChant.performerTenureId)} is distributing inspiration.`;
		}
		return '';
	});
</script>

{#if visible}
	<section class="camp-panel" data-testid="camp-panel" aria-label="Camp actions">
		<header>
			<h2>Camp</h2>
			{#if highChant}
				<p class="stage" data-testid="camp-stage">{highChant.stage === 'select' ? 'Selecting inspiration' : 'Distributing inspiration'}</p>
			{:else if leeches}
				<p class="stage" data-testid="camp-stage">{leeches.stage === 'draw' ? 'Applying leeches' : 'Leeches resolved'}</p>
			{/if}
		</header>

		<p class="sr-only" role="status" aria-live="polite" data-testid="camp-announcement">{announcement}</p>

		{#if camp && camp.inspiration.some((entry) => entry.count > 0)}
			<ul class="inspiration" aria-label="Inspiration cards held" data-testid="inspiration-holdings">
				{#each camp.inspiration.filter((entry) => entry.count > 0) as entry (entry.tenureId)}
					<li>{nameFor(entry.tenureId)} holds {entry.count} inspiration card{entry.count === 1 ? '' : 's'}</li>
				{/each}
			</ul>
		{/if}

		{#if camp?.myInspiration && !camp.myInspiration.hidden}
			<p class="mine" data-testid="my-inspiration">Your inspiration card: {camp.myInspiration.label}</p>
		{/if}

		{#if highChant}
			<dl class="facts">
				<dt>Performer</dt>
				<dd data-testid="chant-performer">{nameFor(highChant.performerTenureId)}</dd>
				<dt>Allowance</dt>
				<dd data-testid="chant-allowance">{highChant.allowance}</dd>
				{#if highChant.stage === 'distribute'}
					<dt>Left to hand out</dt>
					<dd data-testid="chant-undistributed">{highChant.undistributedCount}</dd>
				{/if}
			</dl>
		{/if}

		{#if leeches}
			<dl class="facts">
				<dt>Applying</dt>
				<dd data-testid="leech-actor">{nameFor(leeches.actorTenureId)}</dd>
				<dt>Target</dt>
				<dd data-testid="leech-target">{nameFor(leeches.targetTenureId)}</dd>
			</dl>
			<p class="hint" data-testid="leech-rule">
				{suitList(leeches.noEffectSuits)}: nothing happens. {suitList(leeches.cureSuits)}: counts as burning charges to cure an affliction.
			</p>
			{#if leeches.drawnCard && !leeches.drawnCard.hidden}
				<p class="card" data-testid="leech-card">Drew {leeches.drawnCard.label}</p>
			{/if}
			{#if leeches.outcome}
				<p class="outcome" data-testid="leech-outcome">
					{#if leeches.outcome.effect === 'cure-affliction'}
						Counts as burning {leeches.outcome.charges} charges to cure an affliction.
					{:else}
						Nothing happens.
					{/if}
					<span class="manual"> Apply this on the character sheet — the app does not.</span>
				</p>
			{/if}
		{/if}

		{#if controls.includes('begin-high-chant')}
			<button
				type="button"
				onclick={() => actionRunner.run({ type: 'begin-high-chant' })}
				disabled={actionRunner.pending}
				data-testid="begin-high-chant">Perform the High Chant</button
			>
		{/if}

		{#if controls.includes('select-inspiration')}
			<fieldset class="controls">
				<legend>Take inspiration from the minor discard</legend>
				{#if discardChoices.length === 0}
					<p class="hint" data-testid="empty-discard-hint">The minor discard is empty — there is nothing to draw inspiration from yet.</p>
				{:else}
					{#each discardChoices as slot (slot.hidden ? 'hidden' : slot.id)}
						{#if !slot.hidden}
							<label>
								<input type="checkbox" checked={picked.includes(slot.id)} onchange={() => togglePick(slot.id)} data-testid={`pick-${slot.id}`} />
								{slot.label}
							</label>
						{/if}
					{/each}
					<button type="button" onclick={submitSelection} disabled={actionRunner.pending || picked.length === 0} data-testid="submit-selection">
						Take {picked.length || ''} card{picked.length === 1 ? '' : 's'}
					</button>
				{/if}
			</fieldset>
		{/if}

		{#if controls.includes('complete-high-chant-transfer') && highChant?.mySelection.length}
			<fieldset class="controls">
				<legend>Hand one over</legend>
				<label>
					Card
					<select bind:value={selectedCardId} data-testid="hand-over-card">
						<option value="">Choose…</option>
						{#each highChant.mySelection as slot (slot.hidden ? 'hidden' : slot.id)}
							{#if !slot.hidden}
								<option value={slot.id}>{slot.label}</option>
							{/if}
						{/each}
					</select>
				</label>
				<label>
					To
					<select bind:value={recipientTenureId} data-testid="hand-over-recipient">
						<option value="">Choose…</option>
						{#each camp?.inspiration.filter((entry) => !entry.atCap) ?? [] as entry (entry.tenureId)}
							<option value={entry.tenureId}>{nameFor(entry.tenureId)}</option>
						{/each}
					</select>
				</label>
				<button
					type="button"
					onclick={handOver}
					disabled={actionRunner.pending || !selectedCardId || !recipientTenureId}
					data-testid="hand-over">Hand over</button
				>
			</fieldset>
		{/if}

		{#if controls.includes('begin-leeches')}
			<fieldset class="controls">
				<legend>Apply leeches</legend>
				<label>
					To
					<select bind:value={leechTarget} data-testid="leech-target-select">
						<option value="">Choose…</option>
						{#each roster as entry (entry.tenureId)}
							<option value={entry.tenureId}>{entry.characterName}</option>
						{/each}
					</select>
				</label>
				<button type="button" onclick={applyLeeches} disabled={actionRunner.pending || !leechTarget} data-testid="begin-leeches">
					Apply leeches
				</button>
			</fieldset>
		{/if}

		{#if controls.includes('advance-leeches')}
			<button
				type="button"
				onclick={() => actionRunner.run({ type: 'advance-leeches' })}
				disabled={actionRunner.pending}
				data-testid="advance-leeches">Draw</button
			>
		{/if}

		{#if controls.includes('complete-camp-procedure')}
			<button
				type="button"
				onclick={() => actionRunner.run({ type: 'complete-camp-procedure' })}
				disabled={actionRunner.pending}
				data-testid="complete-camp">Finish{highChant && highChant.undistributedCount > 0 ? ' (return the rest to the discard)' : ''}</button
			>
		{/if}

		{#if actionRunner.error}
			<p class="error" role="alert" data-testid="camp-error">{actionRunner.error}</p>
		{/if}
	</section>
{/if}

<style>
	.camp-panel {
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
	.inspiration {
		list-style: none;
		margin: 0;
		padding: 0;
		font-size: 0.9rem;
		color: var(--ink-soft);
	}
	.card,
	.outcome,
	.hint,
	.mine {
		margin: 0;
		font-size: 0.9rem;
	}
	.hint,
	.manual {
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
