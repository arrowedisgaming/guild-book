<script lang="ts">
	import type { GuildBookCharacterData } from '$lib/types/character';
	import type { TalentDefinition } from '$lib/types/content-pack';
	import { canWoundTalent } from '$lib/engine/wounds';
	import Prose from '$lib/components/ui/Prose.svelte';

	interface Props {
		char: GuildBookCharacterData;
		talents: TalentDefinition[];
		onChange: () => void;
	}
	let { char = $bindable(), talents, onChange }: Props = $props();

	const byId = $derived(new Map(talents.map((t) => [t.id, t])));
	let addId = $state('');

	const XP_TO_MASTER = 7;

	function name(id: string) {
		return byId.get(id)?.name ?? id;
	}

	function cycleState(i: number) {
		const t = char.talents[i];
		char.talents[i] = { ...t, state: t.state === 'mastered' ? 'in-training' : 'mastered' };
		onChange();
	}

	function stepXp(i: number, delta: number) {
		const t = char.talents[i];
		const xp = Math.max(0, t.xp + delta);
		// Reaching 7 invested XP masters an in-training talent.
		const state = xp >= XP_TO_MASTER && t.state === 'in-training' ? 'mastered' : t.state;
		char.talents[i] = { ...t, xp, state };
		onChange();
	}

	function toggleWounded(i: number) {
		const t = char.talents[i];
		if (!t.wounded && !canWoundTalent(char)) return; // hard cap: max 2 wounded
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
				xp: 0
			}
		];
		addId = '';
		onChange();
	}

	const available = $derived(talents.filter((t) => !char.talents.some((c) => c.talentId === t.id)));
	const capReached = $derived(!canWoundTalent(char));
</script>

<div class="talents-edit">
	{#if capReached}
		<p class="hint">Two talents are wounded — the cap. Heal one before wounding another.</p>
	{/if}
	{#each char.talents as t, i (t.talentId)}
		<div class="row" class:is-wounded={t.wounded}>
			<div class="head">
				<span class="tname">{name(t.talentId)}</span>
				<button type="button" class="chip" onclick={() => cycleState(i)}>{t.state}</button>
				<button
					type="button"
					class="chip wound"
					disabled={!t.wounded && capReached}
					onclick={() => toggleWounded(i)}
				>
					{t.wounded ? 'wounded — heal' : 'wound'}
				</button>
				{#if t.state === 'in-training'}
					<span class="xp">
						XP {t.xp}/{XP_TO_MASTER}
						<button type="button" onclick={() => stepXp(i, -1)} aria-label="Remove XP">−</button>
						<button type="button" onclick={() => stepXp(i, 1)} aria-label="Add XP">+</button>
					</span>
				{/if}
				<button type="button" class="remove" onclick={() => remove(i)} aria-label="Remove talent">✕</button>
			</div>
			<Prose class="tdesc" text={byId.get(t.talentId)?.description ?? ''} />
		</div>
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
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
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
		border: none;
		background: none;
		color: var(--ink-soft);
		cursor: pointer;
	}
	.row :global(.tdesc) {
		margin: 0.25rem 0 0;
		font-size: 0.8rem;
		color: var(--ink-soft);
	}
	.add {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.25rem;
	}
	.add select {
		flex: 1;
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
