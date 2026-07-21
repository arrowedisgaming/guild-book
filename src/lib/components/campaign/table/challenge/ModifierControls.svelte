<script lang="ts">
	/**
	 * The seven typed Challenge modifiers' command surface (Increment 3 Task
	 * 6): Black Honey, Stun, Brainfever, Counsel, Guardian Angel, Aim, Guard.
	 * Renders ONLY the commands `legalCommands` currently offers — including
	 * the two O1 footguns (`aim-prepare`/`replace-initiative-with-shield`
	 * hidden whenever the server didn't resolve `hasBow`/`hasShield` true for
	 * this actor's own tenure) — never computes eligibility itself. Every
	 * card identity comes from the actor's OWN per-zone Challenge hand (O2).
	 * `manual-consequence-required` outcomes are never rendered as a
	 * mechanical control here (O6) — the table resolves those in fiction.
	 */
	import { challengeHandZoneId } from '$lib/engine/session/procedures/challenge/reducer';
	import type { ChallengeCommand } from '$lib/engine/session/procedures/challenge/command';
	import type { ChallengePlayerProjection, ChallengeProjection } from '$lib/engine/session/procedures/challenge/projection';
	import type { SessionGmProjection, SessionPlayerProjection } from '$lib/types/session';
	import type { ChallengeActionRunner } from './challenge-action.svelte';

	let {
		role,
		userId,
		genericProjection,
		challenge,
		legalCommands,
		actionRunner
	}: {
		role: 'gm' | 'player';
		userId: string;
		genericProjection: SessionPlayerProjection | SessionGmProjection;
		challenge: ChallengeProjection;
		legalCommands: ChallengeCommand['type'][];
		actionRunner: ChallengeActionRunner;
	} = $props();

	function has(type: ChallengeCommand['type']): boolean {
		return legalCommands.includes(type);
	}

	const actingTenureId = $derived(role === 'player' ? (challenge as ChallengePlayerProjection).actingTenureId : null);

	const ownHand = $derived(
		role === 'player' && actingTenureId
			? ((genericProjection as SessionPlayerProjection).privateHandsByZoneId[challengeHandZoneId(actingTenureId)] ?? [])
			: []
	);

	/** Every other participant's owning userId (Counsel targets a USER, and
	 * the rule excludes self — "another adventurer"). */
	const otherParticipantUserIds = $derived(
		Object.entries(challenge.tenureOwners)
			.filter(([, ownerUserId]) => ownerUserId !== userId)
			.map(([, ownerUserId]) => ownerUserId)
			.filter((id, index, all) => all.indexOf(id) === index)
	);

	let blackHoneyTarget = $state('');
	let stunTarget = $state('');
	let stunResolveCard = $state('');
	let brainfeverTarget = $state('');
	let counselRecipient = $state('');
	let counselCard = $state('');
	let guardianAngelTarget = $state('');
	let guardianAngelCard = $state('');
	let aimCard = $state('');
	let guardCard = $state('');

	async function applyBlackHoney(): Promise<void> {
		if (!blackHoneyTarget) return;
		await actionRunner.run({ type: 'apply-black-honey', targetTenureId: blackHoneyTarget });
	}

	async function recordStun(): Promise<void> {
		if (!stunTarget) return;
		await actionRunner.run({ type: 'apply-stun', targetTenureId: stunTarget });
	}

	async function resolveOwnStun(): Promise<void> {
		if (!actingTenureId || !stunResolveCard) return;
		await actionRunner.run({ type: 'apply-stun', targetTenureId: actingTenureId, cardId: stunResolveCard });
	}

	async function applyBrainfever(): Promise<void> {
		if (!brainfeverTarget) return;
		await actionRunner.run({ type: 'apply-brainfever', targetTenureId: brainfeverTarget });
	}

	async function counselTransfer(): Promise<void> {
		if (!counselRecipient || !counselCard) return;
		await actionRunner.run({ type: 'counsel-transfer', recipientUserId: counselRecipient, cardId: counselCard });
	}

	async function guardianAngel(): Promise<void> {
		if (!guardianAngelTarget || !guardianAngelCard) return;
		await actionRunner.run({ type: 'guardian-angel', targetTenureId: guardianAngelTarget, cardId: guardianAngelCard });
	}

	async function aimPrepare(): Promise<void> {
		if (!aimCard) return;
		await actionRunner.run({ type: 'aim-prepare', cardId: aimCard });
	}

	async function replaceInitiativeWithShield(): Promise<void> {
		if (!guardCard) return;
		await actionRunner.run({ type: 'replace-initiative-with-shield', cardId: guardCard });
	}
</script>

{#if has('apply-black-honey') || has('apply-stun') || has('apply-brainfever') || has('counsel-transfer') || has('guardian-angel') || has('aim-prepare') || has('replace-initiative-with-shield')}
	<section class="modifier-controls" data-testid="modifier-controls" aria-label="Challenge modifiers">
		<h3>Modifiers</h3>

		{#if has('apply-black-honey')}
			<div class="modifier" data-testid="modifier-black-honey">
				<span>Black Honey</span>
				<select aria-label="Black Honey target" bind:value={blackHoneyTarget}>
					<option value="">Choose a participant</option>
					{#each challenge.participantTenureIds as tenureId (tenureId)}
						<option value={tenureId}>{tenureId}</option>
					{/each}
				</select>
				<button type="button" disabled={actionRunner.pending || !blackHoneyTarget} onclick={applyBlackHoney}>Apply</button>
			</div>
		{/if}

		{#if has('apply-stun') && role === 'gm'}
			<div class="modifier" data-testid="modifier-stun-record">
				<span>Stun (record)</span>
				<select aria-label="Stun target" bind:value={stunTarget}>
					<option value="">Choose a participant</option>
					{#each challenge.participantTenureIds as tenureId (tenureId)}
						<option value={tenureId}>{tenureId}</option>
					{/each}
				</select>
				<button type="button" disabled={actionRunner.pending || !stunTarget} onclick={recordStun}>Record Stun</button>
			</div>
		{/if}

		{#if has('apply-stun') && role === 'player'}
			<div class="modifier" data-testid="modifier-stun-resolve">
				<span>You are Stunned — choose a card to discard</span>
				<select aria-label="Card to discard for Stun" bind:value={stunResolveCard}>
					<option value="">Choose a card</option>
					{#each ownHand as slot, index (index)}
						{#if !slot.hidden}
							<option value={slot.id}>{slot.label}</option>
						{/if}
					{/each}
				</select>
				<button type="button" disabled={actionRunner.pending || !stunResolveCard} onclick={resolveOwnStun}>Discard</button>
			</div>
		{/if}

		{#if has('apply-brainfever')}
			<div class="modifier" data-testid="modifier-brainfever">
				<span>Brainfever</span>
				<select aria-label="Brainfever target" bind:value={brainfeverTarget}>
					<option value="">Choose a participant</option>
					{#each challenge.participantTenureIds as tenureId (tenureId)}
						<option value={tenureId}>{tenureId}</option>
					{/each}
				</select>
				<button type="button" disabled={actionRunner.pending || !brainfeverTarget} onclick={applyBrainfever}>Apply</button>
			</div>
		{/if}

		{#if has('counsel-transfer')}
			<div class="modifier" data-testid="modifier-counsel">
				<span>Counsel — hand a card to another adventurer</span>
				<select aria-label="Counsel recipient" bind:value={counselRecipient}>
					<option value="">Choose a player</option>
					{#each otherParticipantUserIds as recipientUserId (recipientUserId)}
						<option value={recipientUserId}>{recipientUserId}</option>
					{/each}
				</select>
				<select aria-label="Card to hand over" bind:value={counselCard}>
					<option value="">Choose a card</option>
					{#each ownHand as slot, index (index)}
						{#if !slot.hidden}
							<option value={slot.id}>{slot.label}</option>
						{/if}
					{/each}
				</select>
				<button type="button" disabled={actionRunner.pending || !counselRecipient || !counselCard} onclick={counselTransfer}>
					Give advice
				</button>
			</div>
		{/if}

		{#if has('guardian-angel')}
			<div class="modifier" data-testid="modifier-guardian-angel">
				<span>Guardian Angel</span>
				<select aria-label="Guardian Angel target" bind:value={guardianAngelTarget}>
					<option value="">Choose a target</option>
					{#each challenge.participantTenureIds as tenureId (tenureId)}
						<option value={tenureId}>{tenureId}</option>
					{/each}
				</select>
				<select aria-label="Card to cast Guardian Angel with" bind:value={guardianAngelCard}>
					<option value="">Choose a card</option>
					{#each ownHand as slot, index (index)}
						{#if !slot.hidden}
							<option value={slot.id}>{slot.label}</option>
						{/if}
					{/each}
				</select>
				<button type="button" disabled={actionRunner.pending || !guardianAngelTarget || !guardianAngelCard} onclick={guardianAngel}>
					Cast
				</button>
			</div>
		{/if}

		{#if has('aim-prepare')}
			<div class="modifier" data-testid="modifier-aim">
				<span>Aim</span>
				<select aria-label="Card to prepare for Aim" bind:value={aimCard}>
					<option value="">Choose a card</option>
					{#each ownHand as slot, index (index)}
						{#if !slot.hidden}
							<option value={slot.id}>{slot.label}</option>
						{/if}
					{/each}
				</select>
				<button type="button" disabled={actionRunner.pending || !aimCard} onclick={aimPrepare}>Aim</button>
			</div>
		{/if}

		{#if has('replace-initiative-with-shield')}
			<div class="modifier" data-testid="modifier-guard">
				<span>Guard — replace your Initiative</span>
				<select aria-label="Replacement Initiative card" bind:value={guardCard}>
					<option value="">Choose a card</option>
					{#each ownHand as slot, index (index)}
						{#if !slot.hidden}
							<option value={slot.id}>{slot.label}</option>
						{/if}
					{/each}
				</select>
				<button type="button" disabled={actionRunner.pending || !guardCard} onclick={replaceInitiativeWithShield}>Replace</button>
			</div>
		{/if}

		{#if actionRunner.error}
			<p class="action-error" role="alert">{actionRunner.error}</p>
		{/if}
	</section>
{/if}

<style>
	.modifier-controls {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.75rem;
		border: 1px solid color-mix(in oklab, var(--ink) 18%, transparent);
	}
	h3 {
		margin: 0;
		font-size: 0.9rem;
	}
	.modifier {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.8rem;
	}
	select {
		font-size: 0.8rem;
		padding: 0.2rem;
	}
	button {
		border: 1px solid color-mix(in oklab, var(--accent) 55%, transparent);
		background: none;
		padding: 0.3rem 0.55rem;
		font-family: var(--font-subhead);
		font-size: 0.75rem;
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
