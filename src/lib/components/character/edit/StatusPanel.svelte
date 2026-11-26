<script lang="ts">
	import type { GuildBookCharacterData } from '$lib/types/character';
	import type {
		NamedEntry,
		AfflictionDefinition,
		BondTypeDefinition,
		ItemDefinition
	} from '$lib/types/content-pack';
	import { tick } from 'svelte';
	import { indexItems } from '$lib/engine/encumbrance';
	import { woundOptions, applyWound, type WoundOption } from '$lib/engine/wounds';
	import { bondChargeLines, findBondType, isCustomBondText } from '$lib/character/bonds';

	interface Props {
		char: GuildBookCharacterData;
		conditions: NamedEntry[];
		afflictions: AfflictionDefinition[];
		bondTypes: BondTypeDefinition[];
		items: ItemDefinition[];
		resolveMax: number;
		/** The pack's name for a talent id, or undefined if the pack lacks it. */
		talentName: (id: string) => string | undefined;
		onChange: () => void;
	}
	let {
		char = $bindable(),
		conditions,
		afflictions,
		bondTypes,
		items,
		resolveMax,
		talentName,
		onChange
	}: Props = $props();

	const itemIndex = $derived(indexItems(items));
	const afflictionsById = $derived(new Map(afflictions.map((a) => [a.id, a])));

	let woundOpen = $state(false);
	// Adding a bond or an affliction is occasional, so each form waits behind
	// its button, the way the wound choices do.
	let bondFormOpen = $state(false);
	let afflictionFormOpen = $state(false);
	let bondToggle: HTMLButtonElement | undefined = $state();
	let afflictionToggle: HTMLButtonElement | undefined = $state();
	let bondNameInput: HTMLInputElement | undefined = $state();
	let afflictionSelect: HTMLSelectElement | undefined = $state();
	async function toggleBondForm() {
		bondFormOpen = !bondFormOpen;
		if (!bondFormOpen) return;
		await tick();
		bondNameInput?.focus();
	}
	async function toggleAfflictionForm() {
		afflictionFormOpen = !afflictionFormOpen;
		if (!afflictionFormOpen) return;
		await tick();
		afflictionSelect?.focus();
	}
	let addAfflictionId = $state('');
	let newBondName = $state('');
	// The row currently writing a bond of its own, so the free-text field stays
	// open while it is still empty. Only one row is ever being typed into.
	let customBondRow = $state<number | null>(null);

	// When the working copy is replaced wholesale — Cancel, a 409 refetch, or
	// navigating to another adventurer — the open row's index points at rows
	// that no longer exist and must not force a restored bond into custom mode.
	// Reading only the top-level reference means in-place edits (our own bond
	// mutations) never reset it.
	$effect(() => {
		void char;
		customBondRow = null;
	});

	const choices = $derived(woundOptions(char, itemIndex));

	/**
	 * Splits an option into its action verb (shown in the accent colour) and
	 * what it acts on. A talent the current pack doesn't know — one saved
	 * under an older pack's ids — is named by where it came from, with its
	 * stored id kept visible so two such talents can still be told apart.
	 */
	function woundText(opt: WoundOption): { verb: string; target: string; detail: string } {
		if (opt.type === 'wound-talent') {
			const known = talentName(opt.talentId);
			if (known) return { verb: 'Wound', target: known, detail: 'Unusable until healed' };
			const source = char.talents.find((t) => t.talentId === opt.talentId)?.sourceLabel;
			return {
				verb: 'Wound',
				target: source ? `${source} talent` : 'unknown talent',
				detail: `Unusable until healed · not in the current talent list (${opt.talentId})`
			};
		}
		const space = opt.label.indexOf(' ');
		return space < 0
			? { verb: opt.label, target: '', detail: opt.detail }
			: { verb: opt.label.slice(0, space), target: opt.label.slice(space + 1), detail: opt.detail };
	}

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

	const LORE_MAX = 4;
	/** Tapping an empty pip fills up to it; tapping a filled one empties from it. */
	const tapped = (current: number, pip: number) => (pip < current ? pip : pip + 1);
	function tapResolve(pip: number) {
		const current = Math.min(char.resolve.max, Math.max(0, tapped(char.resolve.current, pip)));
		char.resolve = { ...char.resolve, current };
		onChange();
	}
	function tapLore(pip: number) {
		char.lore = Math.min(LORE_MAX, Math.max(0, tapped(char.lore, pip)));
		onChange();
	}
	const activeConditions = $derived(conditions.filter((c) => char.conditions.includes(c.id) && c.description));

	function addAffliction() {
		if (!addAfflictionId) return;
		char.afflictions = [
			...char.afflictions,
			{ afflictionId: addAfflictionId, customName: null, stage: 1 }
		];
		addAfflictionId = '';
		afflictionFormOpen = false;
		afflictionToggle?.focus();
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
		bondFormOpen = false;
		bondToggle?.focus();
		onChange();
	}
	/** '' = unset, CUSTOM_BOND = the player's own words, else a pack type label. */
	const CUSTOM_BOND = '__custom__';

	function bondTypeValue(text: string, i: number): string {
		if (customBondRow === i) return CUSTOM_BOND;
		if (isCustomBondText(bondTypes, text)) return CUSTOM_BOND;
		return findBondType(bondTypes, text)?.label ?? '';
	}

	function setBondType(i: number, select: HTMLSelectElement) {
		const value = select.value;
		if (value === CUSTOM_BOND) {
			customBondRow = i;
			// Leaving a pack type clears its label so the row starts blank; text
			// the player already wrote is theirs and stays.
			if (findBondType(bondTypes, char.bonds[i].text)) {
				char.bonds[i] = { ...char.bonds[i], text: '' };
			}
		} else {
			if (customBondRow === i) customBondRow = null;
			// The placeholder never destroys the player's own words: a custom
			// row stays custom, and only a pack label resets to blank. Picking
			// a pack type always writes its label.
			if (value !== '' || findBondType(bondTypes, char.bonds[i].text)) {
				char.bonds[i] = { ...char.bonds[i], text: value };
			}
		}
		// Reflect the accepted state back into the DOM. When a change is
		// rejected (the placeholder on a custom row) the derived value does not
		// change, so Svelte has nothing to re-render and the select would stay
		// where the user left it.
		select.value = bondTypeValue(char.bonds[i].text, i);
		onChange();
	}

	function toggleBondCharge(i: number) {
		char.bonds[i] = { ...char.bonds[i], charged: !char.bonds[i].charged };
		onChange();
	}
	function removeBond(i: number) {
		char.bonds = char.bonds.filter((_, idx) => idx !== i);
		// Keep the open custom row pointing at the same bond: rows above the
		// removal shift down one, the removed row itself has no state to keep,
		// and rows below it are untouched.
		if (customBondRow !== null) {
			if (customBondRow === i) customBondRow = null;
			else if (customBondRow > i) customBondRow -= 1;
		}
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
		<div class="meter" role="group" aria-label={`Resolve, ${char.resolve.current} of ${char.resolve.max}`}>
			<span class="lbl">Resolve</span>
			<span class="pips">
				{#each { length: char.resolve.max }, i (i)}
					<button
						type="button"
						class="pip"
						class:on={i < char.resolve.current}
						aria-pressed={i < char.resolve.current}
						aria-label={i < char.resolve.current ? `Spend Resolve down to ${i}` : `Recover Resolve up to ${i + 1}`}
						onclick={() => tapResolve(i)}
					></button>
				{/each}
			</span>
		</div>
		<div class="meter" role="group" aria-label={`Lore bids, ${char.lore} of ${LORE_MAX}`}>
			<span class="lbl">Lore bids</span>
			<span class="pips">
				{#each { length: LORE_MAX }, i (i)}
					<button
						type="button"
						class="pip"
						class:on={i < char.lore}
						aria-pressed={i < char.lore}
						aria-label={i < char.lore ? `Spend lore bids down to ${i}` : `Recover lore bids up to ${i + 1}`}
						onclick={() => tapLore(i)}
					></button>
				{/each}
			</span>
		</div>
	</div>

	<div class="conditions">
		{#each conditions as c (c.id)}
			<label class="cond" class:on={char.conditions.includes(c.id)}>
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

	<!-- Visible text, not a hover title: a phone has no hover. -->
	{#each activeConditions as c (c.id)}
		<p class="cond-note"><strong>{c.name}.</strong> {c.description}</p>
	{/each}
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
				{@const text = woundText(opt)}
				<button type="button" class="wound-opt" onclick={() => takeWound(opt)}>
					<span class="wlabel"><span class="wverb">{text.verb}</span> {text.target}</span>
					<span class="wdetail">{text.detail}</span>
				</button>
			{/each}
		</div>
	{/if}

	<div class="sub">
		<div class="subhead">
			<h3>Bonds</h3>
			<button type="button" class="reveal" bind:this={bondToggle} aria-expanded={bondFormOpen} onclick={toggleBondForm}>Add a bond…</button>
		</div>
		{#each char.bonds as b, i (i)}
			{@const typeValue = bondTypeValue(b.text, i)}
			<div class="bond">
				<button
					type="button"
					class="charge"
					class:on={b.charged}
					onclick={() => toggleBondCharge(i)}
					aria-pressed={b.charged}
					aria-label={`Bond with ${b.targetName || 'guild-mate'} charged`}
					title={b.charged ? 'Charged: burn at camp to heal' : 'Tap when this bond charges'}
				>
					<!-- A lit mark with rays when charged, a faint empty ring when not;
					     the word says it too, so it never rests on shape alone. -->
					<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
						{#if b.charged}
							<circle cx="12" cy="12" r="4.5" fill="currentColor" />
							<path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
						{:else}
							<circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-dasharray="3 3.3" />
						{/if}
					</svg>
					<span>{b.charged ? 'Charged' : 'Uncharged'}</span>
				</button>
				<input class="bname" type="text" bind:value={b.targetName} oninput={onChange} aria-label="Guild-mate's name" />
				<select
					class="btype"
					aria-label="Bond type"
					value={typeValue}
					onchange={(e) => setBondType(i, e.currentTarget)}
				>
					<option value="">Bond type…</option>
					{#each bondTypes as t (t.id)}
						<option value={t.label}>{t.label}</option>
					{/each}
					<option value={CUSTOM_BOND}>Something else…</option>
				</select>
				{#if typeValue === CUSTOM_BOND}
					<input
						class="btext"
						type="text"
						bind:value={b.text}
						oninput={onChange}
						aria-label="Bond in your own words"
						placeholder="the bond between you"
					/>
				{/if}
				<button type="button" class="remove" onclick={() => removeBond(i)} aria-label={`Remove bond with ${b.targetName || 'guild-mate'}`}>Remove</button>
				{#each bondChargeLines(bondTypes, b.text) as line (line)}
					<span class="bcharge">{line}</span>
				{/each}
			</div>
		{/each}
		{#if bondFormOpen}
			<div class="addrow">
				<input
					type="text"
					bind:this={bondNameInput}
					bind:value={newBondName}
					placeholder="Guild-mate's name"
					onkeydown={(e) => {
						if (e.key === 'Enter') { e.preventDefault(); addBond(); }
						else if (e.key === 'Escape') { bondFormOpen = false; bondToggle?.focus(); }
					}}
				/>
				<button type="button" disabled={!newBondName.trim()} onclick={addBond}>Add bond</button>
			</div>
		{/if}
	</div>

	<div class="sub">
		<div class="subhead">
			<h3>Afflictions</h3>
			<button type="button" class="reveal" bind:this={afflictionToggle} aria-expanded={afflictionFormOpen} onclick={toggleAfflictionForm}>Add an affliction…</button>
		</div>
		{#each char.afflictions as a, i (i)}
			<div class="affliction">
				<span class="aname">{afflictionName(a)}</span>
				<span class="ctrl">
					stage {a.stage}
					<button type="button" onclick={() => stepAffliction(i, -1)} aria-label={`Cure a stage of ${afflictionName(a)}`}>−</button>
					<button type="button" onclick={() => stepAffliction(i, 1)} aria-label={`Worsen ${afflictionName(a)} a stage`}>+</button>
				</span>
				<span class="aeffect">{stageEffect(a)}</span>
				<button type="button" class="remove" onclick={() => removeAffliction(i)} aria-label={`Remove ${afflictionName(a)}`}>Remove</button>
			</div>
		{/each}
		{#if afflictionFormOpen}
			<div class="addrow">
				<select bind:this={afflictionSelect} bind:value={addAfflictionId} aria-label="Affliction">
					<option value="">Choose an affliction…</option>
					{#each afflictions as a (a.id)}
						<option value={a.id}>{a.name}</option>
					{/each}
				</select>
				<button type="button" disabled={!addAfflictionId} onclick={addAffliction}>Add affliction</button>
			</div>
		{/if}
	</div>
</section>

<style>
	.status {
		margin: 1.25rem 0;
		padding: 1rem 1.1rem;
		/* The same frame as every other section of the sheet. */
		border: 1px solid color-mix(in oklab, var(--ink) 18%, transparent);
		border-radius: 4px;
	}
	h2 {
		margin: 0 0 0.6rem;
		font-size: 1.05rem;
	}
	h3 {
		margin: 0;
		font-size: 1rem;
	}
	.subhead {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		margin-bottom: 0.4rem;
	}
	.reveal {
		padding: 0.3rem 0.8rem;
		border: 1px solid color-mix(in oklab, var(--accent) 60%, transparent);
		border-radius: 3px;
		background: transparent;
		color: var(--accent);
		font-family: var(--font-subhead);
		font-size: 0.85rem;
		cursor: pointer;
	}
	.reveal[aria-expanded='true'] {
		background: color-mix(in oklab, var(--accent) 10%, transparent);
	}
	.track {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem 1.75rem;
		margin-bottom: 0.6rem;
	}
	/* Label, pips and count stay together when the row wraps. */
	.meter {
		display: flex;
		align-items: center;
		gap: 0.35rem;
	}
	/* Stacked on a phone: the labels share a width so the pips line up. */
	@media (max-width: 30rem) {
		.meter .lbl {
			min-width: 5.5rem;
		}
	}
	/* line-height 1 and a small lift: the heading face's lowercase sits low in
	 * its box, and the word has to share a centre line with the pips. */
	.lbl {
		font-family: var(--font-heading);
		font-size: 1.1rem;
		line-height: 1;
		translate: 0 -0.08em;
	}
	.pips {
		display: inline-flex;
	}
	/* The button is the hit area; the circle is drawn inside it. */
	.pip {
		display: grid;
		place-items: center;
		width: 2rem;
		height: 2rem;
		padding: 0;
		border: none;
		background: none;
		cursor: pointer;
	}
	.pip::before {
		content: '';
		width: 1.15rem;
		height: 1.15rem;
		border-radius: 999px;
		border: 2px solid color-mix(in oklab, var(--ink) 55%, transparent);
	}
	.pip.on::before {
		background: var(--accent);
		border-color: var(--accent);
	}
	.pip:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}
	.ctrl button {
		width: 2rem;
		height: 2rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 3px;
		background: var(--parchment);
		color: var(--ink);
		cursor: pointer;
	}
	.cond-note {
		margin: 0.5rem 0 0;
		font-size: 0.85rem;
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
		border-color: var(--danger);
		background: color-mix(in oklab, var(--danger) 12%, var(--parchment));
		color: var(--danger);
		font-weight: 600;
	}
	.wound-btn {
		margin-left: auto;
		padding: 0.35rem 0.85rem;
		border: 1px solid var(--danger);
		border-radius: 3px;
		background: var(--danger);
		color: var(--parchment);
		font-family: var(--font-subhead);
		font-size: 0.9rem;
		cursor: pointer;
	}
	.hint {
		margin: 0.5rem 0 0;
		font-size: 0.82rem;
		color: var(--danger);
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
	.wverb {
		color: var(--danger);
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
	/* Charged is a solid ink pill; uncharged is a pale dashed outline. */
	.charge {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		justify-content: center;
		min-width: 8.5rem;
		min-height: 2.4rem;
		padding: 0.3rem 0.9rem;
		border: 1px dashed color-mix(in oklab, var(--ink) 40%, transparent);
		border-radius: 999px;
		background: transparent;
		color: var(--ink-soft);
		font-family: var(--font-subhead);
		font-size: 1.05rem;
		line-height: 1;
		cursor: pointer;
	}
	.charge svg {
		flex: none;
	}
	/* Caslon Antique's letters sit high in their line box; settle them on the mark. */
	.charge span {
		translate: 0 0.06em;
	}
	.charge.on {
		border: 1px solid var(--accent);
		background: var(--accent);
		color: var(--parchment);
	}
	.bname {
		width: 9rem;
	}
	.btext {
		flex: 1;
		min-width: 10rem;
	}
	.btype {
		min-width: 9rem;
	}
	.bcharge {
		flex-basis: 100%;
		font-size: 0.78rem;
		color: var(--ink-soft);
	}
	.bond input,
	.bond select,
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
		padding: 0.25rem 0.5rem;
		border: none;
		background: none;
		font-family: var(--font-subhead);
		font-size: 0.85rem;
		color: var(--ink-soft);
		text-decoration: underline;
		cursor: pointer;
	}
	/* Fingers need 44px; a mouse keeps the denser sheet. */
	@media (pointer: coarse) {
		.pip {
			width: 44px;
			height: 44px;
		}
		.charge {
			min-height: 44px;
		}
		.ctrl button {
			width: 44px;
			height: 44px;
		}
		.cond,
		.reveal,
		.wound-btn,
		.remove,
		.addrow button,
		.bond input,
		.bond select,
		.addrow input,
		.addrow select {
			min-height: 44px;
		}
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
