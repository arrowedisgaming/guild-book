<script lang="ts">
	/**
	 * The GM's round/phase-level Challenge controls (Increment 3 Task 6):
	 * beginning a round (enemy facts + the active roster), dealing, placing
	 * the GM's own Initiative, revealing, beginning turns, hand management
	 * (mulligan/discard), and ending the round. Never a health/damage/
	 * position/range/map/status control (O6) — the enemy-facts form is
	 * limited to exactly the fields `ChallengeEnemyFact` carries: `id`,
	 * `size`, `threat`, `typeIds`, `count`. Every button renders ONLY when its
	 * command type is present in `legalCommands` (O1) — this component
	 * computes no legality of its own.
	 */
	import { renderableCard } from '$lib/stores/campaign-session.svelte';
	import TarotCard from '$lib/components/tarot/TarotCard.svelte';
	import type { ChallengeCommand } from '$lib/engine/session/procedures/challenge/command';
	import type { ChallengeGmProjection, ChallengeProjection } from '$lib/engine/session/procedures/challenge/projection';
	import type { ChallengeEnemyFact } from '$lib/engine/session/procedures/challenge/types';
	import type { ActiveChallengeTenureView } from '$lib/server/campaign/page-data';
	import type { SessionGmProjection } from '$lib/types/session';
	import type { ChallengeActionRunner } from './challenge-action.svelte';

	let {
		genericProjection,
		challenge,
		legalCommands,
		roster,
		actionRunner
	}: {
		genericProjection: SessionGmProjection;
		challenge: ChallengeProjection | null;
		legalCommands: ChallengeCommand['type'][];
		roster: ActiveChallengeTenureView[];
		actionRunner: ChallengeActionRunner;
	} = $props();

	const gmChallenge = $derived(challenge as ChallengeGmProjection | null);
	const gmHand = $derived(genericProjection.gmHand);

	function has(type: ChallengeCommand['type']): boolean {
		return legalCommands.includes(type);
	}

	// ---------------------------------------------------------------------
	// Begin Challenge — roster selection + enemy facts (O6: id/size/threat/
	// typeIds/count only)
	// ---------------------------------------------------------------------

	interface EnemyFactDraft {
		id: string;
		typeIds: string;
		size: string;
		threat: string;
		count: number;
	}

	let selectedTenureIds = $state<Set<string>>(new Set());
	let enemyDrafts = $state<EnemyFactDraft[]>([]);

	function toggleParticipant(tenureId: string): void {
		const next = new Set(selectedTenureIds);
		if (next.has(tenureId)) next.delete(tenureId);
		else next.add(tenureId);
		selectedTenureIds = next;
	}

	function addEnemyDraft(): void {
		enemyDrafts = [...enemyDrafts, { id: `enemy-${enemyDrafts.length + 1}`, typeIds: '', size: 'human', threat: 'minion', count: 1 }];
	}

	function removeEnemyDraft(index: number): void {
		enemyDrafts = enemyDrafts.filter((_draft, i) => i !== index);
	}

	async function beginChallenge(): Promise<void> {
		const participantTenureIds = [...selectedTenureIds];
		const tenureOwners: Record<string, string> = {};
		for (const tenureId of participantTenureIds) {
			const member = roster.find((entry) => entry.tenureId === tenureId);
			if (member) tenureOwners[tenureId] = member.userId;
		}
		const enemyFacts: ChallengeEnemyFact[] = enemyDrafts.map((draft) => ({
			id: draft.id.trim(),
			size: draft.size.trim(),
			threat: draft.threat.trim(),
			typeIds: draft.typeIds
				.split(',')
				.map((typeId) => typeId.trim())
				.filter((typeId) => typeId.length > 0),
			count: Math.max(1, Math.floor(draft.count))
		}));
		await actionRunner.run({ type: 'begin-challenge', participantTenureIds, tenureOwners, enemyFacts });
	}

	// ---------------------------------------------------------------------
	// Round-level actions
	// ---------------------------------------------------------------------

	async function dealRound(): Promise<void> {
		await actionRunner.run({ type: 'deal-round' });
	}

	let gmInitiativeSelection = $state<Record<string, string>>({});

	async function placeGmInitiative(enemyFactId: string): Promise<void> {
		const cardId = gmInitiativeSelection[enemyFactId];
		if (!cardId) return;
		await actionRunner.run({ type: 'place-gm-initiative', enemyFactId, cardId });
	}

	async function revealInitiative(): Promise<void> {
		await actionRunner.run({ type: 'reveal-initiative' });
	}

	async function beginTurns(): Promise<void> {
		await actionRunner.run({ type: 'begin-turns' });
	}

	async function gmMulligan(): Promise<void> {
		await actionRunner.run({ type: 'gm-mulligan' });
	}

	let discardSelection = $state<string | undefined>(undefined);

	async function gmDiscard(): Promise<void> {
		const cardId = discardSelection;
		if (!cardId) return;
		await actionRunner.run({ type: 'gm-discard', cardId });
	}

	async function cleanupRound(): Promise<void> {
		await actionRunner.run({ type: 'cleanup-round' });
	}

	const unplacedEnemyFacts = $derived(
		gmChallenge ? gmChallenge.enemyFacts.filter((enemy) => !gmChallenge.initiativeOrder.some((entry) => entry.tenureId === enemy.id)) : []
	);
</script>

<section class="gm-controls" data-testid="gm-challenge-controls" aria-label="GM Challenge controls">
	{#if has('begin-challenge')}
		<div class="begin-form" data-testid="begin-challenge-form">
			<h3>Begin Challenge</h3>
			<fieldset>
				<legend>Participants</legend>
				{#if roster.length === 0}
					<p class="hint">No active adventurers to include yet.</p>
				{/if}
				{#each roster as member (member.tenureId)}
					<label class="participant">
						<input
							type="checkbox"
							checked={selectedTenureIds.has(member.tenureId)}
							onchange={() => toggleParticipant(member.tenureId)}
						/>
						{member.characterName}
					</label>
				{/each}
			</fieldset>

			<fieldset>
				<legend>Enemy facts (one significant character or one group per entry)</legend>
				{#each enemyDrafts as draft, index (index)}
					<div class="enemy-draft" data-testid="enemy-draft-row">
						<input aria-label="Enemy id" bind:value={draft.id} placeholder="id" />
						<input aria-label="Enemy type ids (comma-separated)" bind:value={draft.typeIds} placeholder="type ids, comma-separated" />
						<input aria-label="Enemy size" bind:value={draft.size} placeholder="size (e.g. larger-than-human)" />
						<input aria-label="Enemy threat" bind:value={draft.threat} placeholder="threat (e.g. elite, dungeon-lord)" />
						<input aria-label="Enemy headcount" type="number" min="1" bind:value={draft.count} />
						<button type="button" onclick={() => removeEnemyDraft(index)}>Remove</button>
					</div>
				{/each}
				<button type="button" onclick={addEnemyDraft}>Add enemy fact</button>
			</fieldset>

			<button
				type="button"
				disabled={actionRunner.pending || selectedTenureIds.size === 0}
				onclick={beginChallenge}
				data-testid="begin-challenge-button"
			>
				Begin Challenge
			</button>
		</div>
	{/if}

	{#if gmChallenge}
		{#if has('deal-round')}
			<button type="button" disabled={actionRunner.pending} onclick={dealRound} data-testid="deal-round-button">Deal Challenge cards</button>
		{/if}

		{#if has('place-gm-initiative')}
			<div class="gm-initiative" data-testid="gm-initiative-form">
				<h3>Place enemy Initiative</h3>
				{#each unplacedEnemyFacts as enemy (enemy.id)}
					<div class="enemy-placement">
						<span>{enemy.id}</span>
						<select aria-label={`Initiative card for ${enemy.id}`} bind:value={gmInitiativeSelection[enemy.id]}>
							<option value={undefined}>Choose a card</option>
							{#each gmHand as slot, index (index)}
								{#if !slot.hidden}
									<option value={slot.id}>{slot.label}</option>
								{/if}
							{/each}
						</select>
						<button
							type="button"
							disabled={actionRunner.pending || !gmInitiativeSelection[enemy.id]}
							onclick={() => placeGmInitiative(enemy.id)}
						>
							Place
						</button>
					</div>
				{/each}
			</div>
		{/if}

		{#if has('reveal-initiative')}
			<button type="button" disabled={actionRunner.pending} onclick={revealInitiative} data-testid="reveal-initiative-button">
				Reveal Initiative
			</button>
		{/if}

		{#if has('begin-turns')}
			<button type="button" disabled={actionRunner.pending} onclick={beginTurns} data-testid="begin-turns-button">Begin turns</button>
		{/if}

		{#if has('gm-discard')}
			<div class="gm-discard" data-testid="gm-discard-form">
				<select aria-label="Card to discard from the GM hand" bind:value={discardSelection}>
					<option value={undefined}>Choose a card</option>
					{#each gmHand as slot, index (index)}
						{#if !slot.hidden}
							<option value={slot.id}>{slot.label}</option>
						{/if}
					{/each}
				</select>
				<button type="button" disabled={actionRunner.pending || !discardSelection} onclick={gmDiscard}>Discard from GM hand</button>
			</div>
		{/if}

		{#if has('gm-mulligan')}
			<button type="button" disabled={actionRunner.pending} onclick={gmMulligan} data-testid="gm-mulligan-button">
				Mulligan the GM hand
			</button>
		{/if}

		{#if has('cleanup-round')}
			<button type="button" disabled={actionRunner.pending} onclick={cleanupRound} data-testid="cleanup-round-button">End round</button>
		{/if}

		<p class="gm-hand-count">GM hand: {gmHand.length} card{gmHand.length === 1 ? '' : 's'}</p>
		<div class="gm-hand-preview">
			{#each gmHand as slot, index (index)}
				{@const rendered = renderableCard(slot)}
				<TarotCard card={rendered.card} faceDown={rendered.faceDown} size="sm" />
			{/each}
		</div>
	{/if}

	{#if actionRunner.error}
		<p class="action-error" role="alert">{actionRunner.error}</p>
	{/if}
</section>

<style>
	.gm-controls {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 0.75rem;
		border: 1px solid color-mix(in oklab, var(--ink) 18%, transparent);
	}
	h3 {
		margin: 0 0 0.35rem;
		font-size: 0.9rem;
	}
	fieldset {
		border: 1px solid color-mix(in oklab, var(--ink) 14%, transparent);
		padding: 0.5rem;
	}
	.participant {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.85rem;
	}
	.enemy-draft {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		margin-bottom: 0.4rem;
	}
	.enemy-draft input {
		flex: 1 1 8rem;
	}
	.enemy-placement,
	.gm-discard {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.85rem;
	}
	.hint {
		margin: 0;
		font-size: 0.8rem;
		color: var(--ink-soft);
	}
	.gm-hand-count {
		margin: 0;
		font-size: 0.8rem;
		color: var(--ink-soft);
	}
	.gm-hand-preview {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
	}
	button {
		border: 1px solid color-mix(in oklab, var(--accent) 55%, transparent);
		background: none;
		padding: 0.4rem 0.7rem;
		font-family: var(--font-subhead);
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.action-error {
		margin: 0;
		padding: 0.4rem 0.6rem;
		border: 1px solid color-mix(in oklab, #b3261e 60%, transparent);
		color: #b3261e;
		font-size: 0.8rem;
	}
</style>
