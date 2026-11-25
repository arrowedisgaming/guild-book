<script lang="ts">
	import type { GuildBookCharacterData } from '$lib/types/character';
	import type { TalentDefinition, PathDefinition } from '$lib/types/content-pack';
	import { isOwnPathTalent, type XpAction } from '$lib/engine/experience';
	import { canWoundTalent, isWoundableTalent, canReturnToTraining } from '$lib/engine/wounds';
	import Prose from '$lib/components/ui/Prose.svelte';

	interface Props {
		char: GuildBookCharacterData;
		talents: TalentDefinition[];
		masteryXp: number;
		/** XP one use of an own-path talent costs. */
		pathUseXp: number;
		paths: PathDefinition[];
		onChange: () => void;
		/** Records a change in the XP history; resolves true once it is saved. */
		onXpAction: (action: XpAction, reason: string) => Promise<boolean>;
	}
	let { char = $bindable(), talents, masteryXp, pathUseXp, paths, onChange, onXpAction }: Props = $props();

	/** How a talent in training advances, which depends on whose path it is on. */
	function training(talentId: string): 'own-path' | 'other-path' | 'free' {
		if (isOwnPathTalent(char.pathId, talentId, paths)) return 'own-path';
		return paths.some((p) => p.talentIds.includes(talentId)) ? 'other-path' : 'free';
	}

	// Mentoring is filled in on one row at a time.
	let mentorFor = $state<string | null>(null);
	let mentorName = $state('');
	let mentorAmount = $state(1);
	let mentorPhase = $state<'camp' | 'city'>('camp');
	async function train(talentId: string, talentLabel: string) {
		const mentor = mentorName.trim();
		if (!mentor) return;
		const ok = await onXpAction(
			{ kind: 'mentoring', talentId, amount: mentorAmount, mentor, phase: mentorPhase },
			`Trained ${talentLabel} with ${mentor}`
		);
		if (ok) { mentorFor = null; mentorName = ''; mentorAmount = 1; }
	}

	const byId = $derived(new Map(talents.map((t) => [t.id, t])));
	let addId = $state('');

	function name(id: string) {
		return byId.get(id)?.name ?? id;
	}

	function cycleState(i: number) {
		const t = char.talents[i];
		if (t.state === 'mastered') {
			if (!canReturnToTraining(t)) return; // heal it first
			// Back in training, invested XP has to sit below the mastery threshold.
			char.talents[i] = { ...t, state: 'in-training', xp: Math.min(t.xp, masteryXp - 1) };
		} else {
			char.talents[i] = { ...t, state: 'mastered' };
		}
		onChange();
	}

	function stepXp(i: number, delta: number) {
		const t = char.talents[i];
		const xp = Math.max(0, Math.min(masteryXp, t.xp + delta));
		// Reaching the threshold masters an in-training talent.
		const state = xp >= masteryXp && t.state === 'in-training' ? 'mastered' : t.state;
		char.talents[i] = { ...t, xp, state };
		onChange();
	}

	function toggleWounded(i: number) {
		const t = char.talents[i];
		// Hard rules: max 2 wounded, and only a mastered talent can be wounded.
		// Healing an already-wounded talent is always allowed.
		if (!t.wounded && (!canWoundTalent(char) || !isWoundableTalent(t))) return;
		char.talents[i] = { ...t, wounded: !t.wounded };
		onChange();
	}

	function remove(i: number) {
		char.talents = char.talents.filter((_, idx) => idx !== i);
		onChange();
	}

	function add() {
		if (!addId || char.talents.some((t) => t.talentId === addId)) return;
		const def = byId.get(addId);
		char.talents = [
			...char.talents,
			{
				talentId: addId,
				state: 'in-training',
				source: def?.source === 'arete' ? 'arete' : 'general',
				sourceLabel: 'Added on sheet',
				at: new Date().toISOString(),
				wounded: false,
				xp: 0,
				preparedUses: 0
			}
		];
		addId = '';
		onChange();
	}

	const available = $derived(talents.filter((t) => !char.talents.some((c) => c.talentId === t.id)));
	const capReached = $derived(!canWoundTalent(char));
	// A disabled button can't take focus, so its reason must be visible text
	// the button points at, not just a hover title.
	const uid = $props.id();
	const ruleId = `${uid}-wound-rule`;
	const healFirstId = `${uid}-heal-first`;
	const hasUnwoundable = $derived(char.talents.some((t) => !t.wounded && !isWoundableTalent(t)));
	const hasWoundedMastered = $derived(char.talents.some((t) => t.state === 'mastered' && t.wounded));
</script>

<div class="talents-edit">
	<p class="balance">{char.experience} XP to spend</p>
	{#if capReached}
		<p class="hint">Two talents are wounded — the cap. Heal one before wounding another.</p>
	{/if}
	{#if hasUnwoundable}
		<p class="hint" id={ruleId}>Only mastered talents can be wounded.</p>
	{/if}
	{#if hasWoundedMastered}
		<p class="hint" id={healFirstId}>Heal a wounded talent before moving it back into training.</p>
	{/if}
	{#each char.talents as t, i (t.talentId)}
		{@const tname = name(t.talentId)}
		<!-- Closed, a row reads like a line on a paper sheet; opened, it shows
		     what the talent does and the controls that change it. -->
		<details class="row" class:is-wounded={t.wounded}>
			<summary>
				<span class="tname">{tname}</span>
				<span class="tstate">
					{t.state === 'mastered' ? 'Mastered' : `In training, ${t.xp} of ${masteryXp} XP`}
				</span>
				{#if t.wounded}<span class="twound">Wounded</span>{/if}
				<svg class="chevron" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
			</summary>
			<Prose class="tdesc" text={byId.get(t.talentId)?.description ?? ''} />
			<div class="controls">
				<button
					type="button"
					class="chip"
					disabled={t.state === 'mastered' && !canReturnToTraining(t)}
					aria-describedby={t.state === 'mastered' && !canReturnToTraining(t) ? healFirstId : undefined}
					onclick={() => cycleState(i)}
				>
					{t.state}
				</button>
				<button
					type="button"
					class="chip wound"
					disabled={!t.wounded && (capReached || !isWoundableTalent(t))}
					aria-describedby={!t.wounded && !isWoundableTalent(t) ? ruleId : undefined}
					onclick={() => toggleWounded(i)}
				>
					{t.wounded ? 'wounded — heal' : 'wound'}
				</button>
				<button type="button" class="remove" onclick={() => remove(i)} aria-label={`Remove ${tname}`}>Remove</button>
			</div>
			{#if t.state === 'in-training'}
				{@const how = training(t.talentId)}
				<div class="advance">
					{#if how === 'own-path'}
						<button
							type="button"
							class="spend"
							disabled={t.wounded || char.experience < pathUseXp}
							onclick={() => onXpAction({ kind: 'talent-use', talentId: t.talentId }, `Used ${tname}`)}
						>
							Use for {pathUseXp} XP
						</button>
						{#if char.experience < pathUseXp}<span class="hint quiet">No XP to spend.</span>{/if}
					{:else if how === 'other-path'}
						<span class="prepared">Prepared uses: {t.preparedUses ?? 'not set'}</span>
						<button
							type="button"
							class="spend"
							disabled={t.wounded || !t.preparedUses}
							onclick={() => onXpAction({ kind: 'prepared-use', talentId: t.talentId }, `Used ${tname}`)}
						>
							Use one
						</button>
						<button
							type="button"
							class="spend"
							aria-expanded={mentorFor === t.talentId}
							disabled={t.wounded}
							onclick={() => (mentorFor = mentorFor === t.talentId ? null : t.talentId)}
						>
							Train with a mentor
						</button>
						{#if mentorFor === t.talentId}
							<form class="mentor" onsubmit={(e) => { e.preventDefault(); void train(t.talentId, tname); }}>
								<label>Mentor<input required maxlength="200" bind:value={mentorName} /></label>
								<label>XP to spend<input type="number" required min="1" max={Math.min(masteryXp - t.xp, Math.max(char.experience, 1))} step="1" bind:value={mentorAmount} /></label>
								<label>Where<select bind:value={mentorPhase}><option value="camp">At camp</option><option value="city">In the city</option></select></label>
								<button type="submit" class="spend" disabled={!mentorName.trim() || char.experience < mentorAmount}>Train</button>
							</form>
						{/if}
					{/if}
					<details class="adjust">
						<summary>Adjust without spending XP</summary>
						<span class="xp">
							XP {t.xp}/{masteryXp}
							<button type="button" onclick={() => stepXp(i, -1)} aria-label="Remove XP">−</button>
							<button type="button" onclick={() => stepXp(i, 1)} aria-label="Add XP">+</button>
						</span>
					</details>
				</div>
			{/if}
		</details>
	{/each}

	<div class="add">
		<select bind:value={addId}>
			<option value="">Add a talent…</option>
			{#each available as t (t.id)}
				<option value={t.id}>{t.name} ({t.source})</option>
			{/each}
		</select>
		<button type="button" disabled={!addId} onclick={add}>Add</button>
	</div>
</div>

<style>
	.talents-edit {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.hint {
		margin: 0;
		font-size: 0.85rem;
		color: var(--accent);
	}
	.row {
		padding: 0.55rem 0.7rem;
		border: 1px solid color-mix(in oklab, var(--ink) 18%, transparent);
		border-radius: 4px;
	}
	.row.is-wounded {
		border-color: var(--accent);
		background: color-mix(in oklab, var(--accent) 6%, var(--parchment));
	}
	summary {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.15rem 0.75rem;
		min-height: 1.75rem;
		cursor: pointer;
	}
	summary::-webkit-details-marker {
		display: none;
	}
	.chevron {
		align-self: center;
		margin-left: auto;
		color: var(--ink-soft);
		transition: transform 0.15s;
	}
	details[open] > summary .chevron {
		transform: rotate(180deg);
	}
	@media (prefers-reduced-motion: reduce) {
		.chevron {
			transition: none;
		}
	}
	summary:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 3px;
	}
	.tstate {
		font-family: var(--font-subhead);
		font-size: 0.85rem;
		color: var(--ink-soft);
	}
	.twound {
		font-family: var(--font-subhead);
		font-size: 0.85rem;
		color: var(--accent);
	}
	.controls {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		margin-top: 0.6rem;
	}
	.tname {
		font-family: var(--font-heading);
		font-size: 1rem;
	}
	.row.is-wounded .tname {
		text-decoration: line-through;
	}
	.chip {
		padding: 0.1rem 0.55rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 999px;
		background: transparent;
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		cursor: pointer;
		color: var(--ink-soft);
	}
	.chip.wound {
		border-color: color-mix(in oklab, var(--accent) 55%, transparent);
		color: var(--accent);
	}
	.chip:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.balance {
		margin: 0;
		font-family: var(--font-subhead);
		font-size: 0.9rem;
		color: var(--ink-soft);
		font-variant-numeric: lining-nums;
	}
	.advance {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 0.75rem;
		margin-top: 0.6rem;
		padding-top: 0.6rem;
		border-top: 1px solid color-mix(in oklab, var(--ink) 14%, transparent);
	}
	.spend {
		min-height: 2.75rem;
		padding: 0.4rem 0.9rem;
		border: 1px solid var(--accent);
		border-radius: 3px;
		background: var(--accent);
		color: var(--parchment);
		font-family: var(--font-subhead);
		font-size: 0.95rem;
		cursor: pointer;
	}
	.spend[aria-expanded] {
		background: transparent;
		color: var(--accent);
	}
	.spend:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.prepared,
	.quiet {
		font-size: 0.85rem;
		color: var(--ink-soft);
	}
	.mentor {
		flex: 1 0 100%;
		display: grid;
		grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr) auto;
		align-items: end;
		gap: 0.5rem;
	}
	.mentor label {
		display: grid;
		gap: 0.2rem;
		font-size: 0.85rem;
	}
	.mentor input,
	.mentor select {
		box-sizing: border-box;
		width: 100%;
		min-width: 0;
		padding: 0.45rem 0.5rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 3px;
		background: var(--parchment);
		color: var(--ink);
		font: inherit;
	}
	@media (max-width: 34rem) {
		.mentor {
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		}
	}
	.adjust {
		margin-left: auto;
		font-size: 0.85rem;
		color: var(--ink-soft);
	}
	.adjust summary {
		display: block;
		min-height: 0;
		text-decoration: underline;
	}
	.adjust .xp {
		margin-top: 0.4rem;
	}
	.xp {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.8rem;
		color: var(--ink-soft);
	}
	.xp button {
		width: 1.4rem;
		height: 1.4rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 3px;
		background: var(--parchment);
		cursor: pointer;
	}
	.remove {
		margin-left: auto;
		padding: 0.25rem 0.6rem;
		border: none;
		background: none;
		font-family: var(--font-subhead);
		font-size: 0.85rem;
		color: var(--ink-soft);
		text-decoration: underline;
		cursor: pointer;
	}
	.row :global(.tdesc) {
		margin: 0.5rem 0 0;
		font-size: 0.9rem;
	}
	.add {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.25rem;
	}
	.add select {
		flex: 1;
		min-width: 0;
		padding: 0.45rem 0.6rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 3px;
		background: var(--parchment);
		font: inherit;
		font-size: 0.9rem;
	}
	.add button {
		padding: 0.45rem 1rem;
		border: 1px solid var(--accent);
		border-radius: 3px;
		background: var(--accent);
		color: var(--parchment);
		font-family: var(--font-subhead);
		cursor: pointer;
	}
	.add button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
