<script lang="ts">
	import type { GuildBookCharacterData } from '$lib/types/character';
	import type { NamedEntry, AfflictionDefinition, ItemDefinition } from '$lib/types/content-pack';
	import { indexItems } from '$lib/engine/encumbrance';
	import { woundOptions, applyWound, type WoundOption } from '$lib/engine/wounds';

	interface Props {
		char: GuildBookCharacterData;
		conditions: NamedEntry[];
		afflictions: AfflictionDefinition[];
		items: ItemDefinition[];
		resolveMax: number;
		talentName: (id: string) => string;
		onChange: () => void;
	}
	let { char = $bindable(), conditions, afflictions, items, resolveMax, talentName, onChange }: Props = $props();

	const itemIndex = $derived(indexItems(items));
	const afflictionsById = $derived(new Map(afflictions.map((a) => [a.id, a])));

	let woundOpen = $state(false);
	let addAfflictionId = $state('');
	let newBondName = $state('');

	const choices = $derived(woundOptions(char, itemIndex));

	function toggleCondition(id: string) {
		char.conditions = char.conditions.includes(id)
			? char.conditions.filter((c) => c !== id)
			: [...char.conditions, id];
		onChange();
	}

	function takeWound(option: WoundOption) {
		const next = applyWound(char, option);
		char.conditions = next.conditions;
		char.talents = next.talents;
		char.equipment = next.equipment;
		woundOpen = false;
		onChange();
	}

	function stepResolve(delta: number) {
		const current = Math.min(char.resolve.max, Math.max(0, char.resolve.current + delta));
		char.resolve = { ...char.resolve, current };
		onChange();
	}
	function stepLore(delta: number) {
		char.lore = Math.min(4, Math.max(0, char.lore + delta));
		onChange();
	}

	function addAffliction() {
		if (!addAfflictionId) return;
		char.afflictions = [
			...char.afflictions,
			{ afflictionId: addAfflictionId, customName: null, stage: 1 }
		];
		addAfflictionId = '';
		onChange();
	}
	function stepAffliction(i: number, delta: number) {
		const a = char.afflictions[i];
		const def = a.afflictionId ? afflictionsById.get(a.afflictionId) : undefined;
		const max = def?.stages.length ?? 6;
		const stage = Math.max(1, Math.min(max, a.stage + delta));
		char.afflictions[i] = { ...a, stage };
		onChange();
	}
	function removeAffliction(i: number) {
		char.afflictions = char.afflictions.filter((_, idx) => idx !== i);
		onChange();
	}

	function addBond() {
		const targetName = newBondName.trim();
		if (!targetName) return;
		char.bonds = [...char.bonds, { targetName, text: '', charged: false }];
		newBondName = '';
		onChange();
	}
	function toggleBondCharge(i: number) {
		char.bonds[i] = { ...char.bonds[i], charged: !char.bonds[i].charged };
		onChange();
	}
	function removeBond(i: number) {
		char.bonds = char.bonds.filter((_, idx) => idx !== i);
		onChange();
	}

	function stageEffect(a: (typeof char.afflictions)[number]): string {
		const def = a.afflictionId ? afflictionsById.get(a.afflictionId) : undefined;
		return def?.stages.find((s) => s.stage === a.stage)?.effect ?? '';
	}
	function afflictionName(a: (typeof char.afflictions)[number]): string {
		return a.customName ?? (a.afflictionId ? (afflictionsById.get(a.afflictionId)?.name ?? a.afflictionId) : 'Affliction');
	}
</script>

<section class="status">
	<h2>Status</h2>

	<div class="track">
		<span class="lbl">Resolve</span>
		<span class="pips">
			{#each Array.from({ length: char.resolve.max }) as _, i}
				<span class="pip" class:on={i < char.resolve.current}></span>
			{/each}
		</span>
		<button type="button" onclick={() => stepResolve(-1)} aria-label="Spend resolve">−</button>
		<button type="button" onclick={() => stepResolve(1)} aria-label="Recover resolve">+</button>
		<span class="lbl second">Lore bids</span>
		<span class="pips">
			{#each Array.from({ length: 4 }) as _, i}
				<span class="pip" class:on={i < char.lore}></span>
			{/each}
		</span>
		<button type="button" onclick={() => stepLore(-1)} aria-label="Spend lore bid">−</button>
		<button type="button" onclick={() => stepLore(1)} aria-label="Recover lore bid">+</button>
	</div>

	<div class="conditions">
		{#each conditions as c (c.id)}
			<label class="cond" class:on={char.conditions.includes(c.id)} title={c.description}>
				<input
					type="checkbox"
					checked={char.conditions.includes(c.id)}
					onchange={() => toggleCondition(c.id)}
				/>
				{c.name}
			</label>
		{/each}
		<button type="button" class="wound-btn" onclick={() => (woundOpen = !woundOpen)}>
			Take a Wound…
		</button>
	</div>

	{#if char.conditions.includes('stressed')}
		<p class="hint">Stressed blocks all other recovery — clear it first at camp.</p>
	{/if}
	{#if char.conditions.includes('injured')}
		<p class="hint">Injured: by the rules, your next wound must be Death's Door.</p>
	{/if}

	{#if woundOpen}
		<div class="wound-menu">
			{#each choices.hints as h}<p class="hint">{h}</p>{/each}
			{#each choices.options as opt, i (i)}
				<button type="button" class="wound-opt" onclick={() => takeWound(opt)}>
					<span class="wlabel">
						{opt.type === 'wound-talent' ? `Wound ${talentName(opt.detail)}` : opt.label}
					</span>
					<span class="wdetail">{opt.type === 'wound-talent' ? 'Unusable until healed' : opt.detail}</span>
				</button>
			{/each}
		</div>
	{/if}

	<div class="sub">
		<h3>Bonds</h3>
		{#each char.bonds as b, i (i)}
			<div class="bond">
				<button
					type="button"
					class="charge"
					class:on={b.charged}
					onclick={() => toggleBondCharge(i)}
					title={b.charged ? 'Charged — burn at camp to heal' : 'Uncharged'}
				>
					{b.charged ? '●' : '○'}
				</button>
				<input class="bname" type="text" bind:value={b.targetName} oninput={onChange} />
				<input class="btext" type="text" bind:value={b.text} oninput={onChange} placeholder="the bond between you" />
				<button type="button" class="remove" onclick={() => removeBond(i)} aria-label="Remove bond">✕</button>
			</div>
		{/each}
		<div class="addrow">
			<input type="text" bind:value={newBondName} placeholder="Guild-mate's name" />
			<button type="button" disabled={!newBondName.trim()} onclick={addBond}>Add bond</button>
		</div>
	</div>

	<div class="sub">
		<h3>Afflictions</h3>
		{#each char.afflictions as a, i (i)}
			<div class="affliction">
				<span class="aname">{afflictionName(a)}</span>
				<span class="ctrl">
					stage {a.stage}
					<button type="button" onclick={() => stepAffliction(i, -1)} aria-label="Cure a stage">−</button>
					<button type="button" onclick={() => stepAffliction(i, 1)} aria-label="Worsen a stage">+</button>
				</span>
				<span class="aeffect">{stageEffect(a)}</span>
				<button type="button" class="remove" onclick={() => removeAffliction(i)} aria-label="Remove affliction">✕</button>
			</div>
		{/each}
		<div class="addrow">
			<select bind:value={addAfflictionId}>
				<option value="">Add an affliction…</option>
				{#each afflictions as a (a.id)}
					<option value={a.id}>{a.name}</option>
				{/each}
			</select>
			<button type="button" disabled={!addAfflictionId} onclick={addAffliction}>Add</button>
		</div>
	</div>
</section>

<style>
	.status {
		margin: 1.25rem 0;
		padding: 1rem 1.1rem;
		border: 1px solid color-mix(in oklab, var(--accent) 35%, transparent);
		border-radius: 4px;
		background: color-mix(in oklab, var(--surface) 70%, var(--parchment));
	}
	h2 {
		margin: 0 0 0.6rem;
		font-size: 1.05rem;
	}
	h3 {
		margin: 0 0 0.4rem;
		font-size: 0.9rem;
	}
	.track {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem;
		margin-bottom: 0.6rem;
	}
	.lbl {
		font-family: var(--font-subhead);
		font-size: 0.85rem;
	}
	.lbl.second {
		margin-left: 1rem;
	}
	.pips {
		display: inline-flex;
		gap: 0.25rem;
	}
	.pip {
		width: 0.8rem;
		height: 0.8rem;
		border-radius: 999px;
		border: 1px solid color-mix(in oklab, var(--ink) 40%, transparent);
	}
	.pip.on {
		background: var(--accent);
		border-color: var(--accent);
	}
	.track button,
	.ctrl button {
		width: 1.5rem;
		height: 1.5rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 3px;
		background: var(--parchment);
		cursor: pointer;
	}
	.conditions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}
	.cond {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.25rem 0.6rem;
		border: 1px solid color-mix(in oklab, var(--ink) 22%, transparent);
		border-radius: 999px;
		font-size: 0.85rem;
		cursor: pointer;
	}
	.cond.on {
		border-color: var(--accent);
		background: color-mix(in oklab, var(--accent) 12%, var(--parchment));
		color: var(--accent);
		font-weight: 600;
	}
	.wound-btn {
		margin-left: auto;
		padding: 0.35rem 0.85rem;
		border: 1px solid var(--accent);
		border-radius: 3px;
		background: var(--accent);
		color: var(--parchment);
		font-family: var(--font-subhead);
		font-size: 0.9rem;
		cursor: pointer;
	}
	.hint {
		margin: 0.5rem 0 0;
		font-size: 0.82rem;
		color: var(--accent);
	}
	.wound-menu {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		margin-top: 0.6rem;
		padding: 0.6rem;
		border: 1px dashed color-mix(in oklab, var(--accent) 45%, transparent);
		border-radius: 4px;
	}
	.wound-opt {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.1rem;
		padding: 0.45rem 0.6rem;
		border: 1px solid color-mix(in oklab, var(--ink) 18%, transparent);
		border-radius: 4px;
		background: var(--parchment);
		cursor: pointer;
		text-align: left;
	}
	.wound-opt:hover {
		border-color: var(--accent);
	}
	.wlabel {
		font-family: var(--font-heading);
		font-size: 0.95rem;
	}
	.wdetail {
		font-size: 0.75rem;
		color: var(--ink-soft);
	}
	.sub {
		margin-top: 0.9rem;
		padding-top: 0.7rem;
		border-top: 1px solid color-mix(in oklab, var(--ink) 12%, transparent);
	}
	.bond,
	.affliction {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.45rem;
		margin-bottom: 0.35rem;
		font-size: 0.88rem;
	}
	.charge {
		width: 1.6rem;
		height: 1.6rem;
		border: 1px solid color-mix(in oklab, var(--accent) 50%, transparent);
		border-radius: 999px;
		background: transparent;
		color: var(--accent);
		cursor: pointer;
		font-size: 0.9rem;
	}
	.charge.on {
		background: color-mix(in oklab, var(--accent) 14%, var(--parchment));
	}
	.bname {
		width: 9rem;
	}
	.btext {
		flex: 1;
		min-width: 10rem;
	}
	.bond input,
	.addrow input,
	.addrow select {
		padding: 0.35rem 0.5rem;
		border: 1px solid color-mix(in oklab, var(--ink) 22%, transparent);
		border-radius: 3px;
		background: var(--parchment);
		font: inherit;
		font-size: 0.85rem;
	}
	.aname {
		font-family: var(--font-heading);
	}
	.ctrl {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.8rem;
		color: var(--ink-soft);
	}
	.aeffect {
		flex-basis: 100%;
		font-size: 0.78rem;
		color: var(--ink-soft);
	}
	.remove {
		margin-left: auto;
		border: none;
		background: none;
		color: var(--ink-soft);
		cursor: pointer;
	}
	.addrow {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.3rem;
	}
	.addrow select,
	.addrow input {
		flex: 1;
	}
	.addrow button {
		padding: 0.35rem 0.9rem;
		border: 1px solid var(--accent);
		border-radius: 3px;
		background: transparent;
		color: var(--accent);
		font-family: var(--font-subhead);
		font-size: 0.85rem;
		cursor: pointer;
	}
	.addrow button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
