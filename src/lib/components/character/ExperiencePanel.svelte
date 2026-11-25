<script lang="ts">
	import type { GuildBookCharacterData } from '$lib/types/character';
	import type { AdvancementConfig } from '$lib/types/content-pack';
	import type { XpAction } from '$lib/engine/experience';

	let { char, config, disabled = false, onAction }: {
		char: GuildBookCharacterData;
		config: AdvancementConfig;
		disabled?: boolean;
		onAction: (action: XpAction, reason: string, sessionLabel?: string) => Promise<boolean>;
	} = $props();

	// Awards with a fixed amount are one tap; the rest need a number typed in.
	const fixedAwards = $derived(config.awards.filter((a) => a.amount !== null));
	const openAwards = $derived(config.awards.filter((a) => a.amount === null));

	type OtherMode = 'spend' | 'award' | 'correction';
	let open = $state(false);
	let reason = $state('');
	let session = $state('');
	let mode = $state<OtherMode>('spend');
	// Only the initial choice comes from the pack; the select owns it after.
	// svelte-ignore state_referenced_locally
	let source = $state(openAwards[0]?.id ?? '');
	let amount = $state(1);

	const uid = $props.id();
	const customAward = $derived(openAwards.find((a) => a.id === source));
	const delta = $derived(mode === 'spend' ? -amount : amount);
	// An award explains itself by its source; a spend or a correction does not.
	const otherNeedsReason = $derived(mode !== 'award');
	const otherReady = $derived(
		Number.isFinite(delta) && (mode !== 'award' || !!customAward) && (!otherNeedsReason || !!reason.trim())
	);

	async function record(action: XpAction, fallbackReason: string) {
		if (await onAction(action, reason.trim() || fallbackReason, session.trim() || undefined)) reason = '';
	}
	function quickAward(id: string, label: string) {
		void record({ kind: 'award', presetId: id }, label);
	}
	function submitOther() {
		if (!otherReady) return;
		if (mode === 'award' && customAward) void record({ kind: 'award', presetId: customAward.id, amount }, customAward.label);
		else if (mode === 'spend') void record({ kind: 'spend', amount }, '');
		else void record({ kind: 'correction', balanceDelta: amount }, '');
	}
</script>

<section aria-label="Experience" class="experience">
	<details bind:open>
		<summary class="toggle">
			<h2>Experience</h2>
			<span class="balance">Available XP: {char.experience}</span>
			<span class="cta">
				{open ? 'Hide' : 'Award XP & history'}
				<svg class="chevron" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
			</span>
		</summary>

		<fieldset {disabled}>
			<div class="awards" role="group" aria-labelledby="{uid}-award">
				<h3 id="{uid}-award">Award XP</h3>
				<div class="chips">
					{#each fixedAwards as award (award.id)}
						<button type="button" class="award" onclick={() => quickAward(award.id, award.label)}>
							{award.label} <span class="plus">+{award.amount}</span>
						</button>
					{/each}
				</div>
			</div>
			<div class="notes">
				<label>Reason<input maxlength="1000" bind:value={reason} placeholder="Optional for awards" /></label>
				<label>Session<input maxlength="200" bind:value={session} placeholder="Optional" /></label>
			</div>
		</fieldset>

		<details class="sub">
			<summary>What earns XP</summary>
			<dl class="earns">
				{#each config.awards as award (award.id)}
					<dt>{award.label}{award.amount !== null ? ` (+${award.amount})` : ''}</dt>
					<dd>{award.reminder}</dd>
				{/each}
			</dl>
		</details>

		<details class="sub">
			<summary>Spend XP, a custom award or a correction</summary>
			<form onsubmit={(event) => { event.preventDefault(); submitOther(); }}>
				<fieldset {disabled}>
					<label>Change<select bind:value={mode}>
						<option value="spend">Spend XP</option>
						{#if openAwards.length}<option value="award">Award a custom amount</option>{/if}
						<option value="correction">Correct the balance</option>
					</select></label>
					{#if mode === 'award'}
						<label>XP source<select bind:value={source}>{#each openAwards as award (award.id)}<option value={award.id}>{award.label}</option>{/each}</select></label>
					{/if}
					<label>{mode === 'correction' ? 'Adjust the balance by' : 'XP amount'}<input type="number" step={mode === 'correction' ? 'any' : '1'} min={mode === 'correction' ? undefined : 1} required bind:value={amount} /></label>
					<p class="preview">Available XP: {char.experience} → {char.experience + delta}</p>
					{#if otherNeedsReason && !reason.trim()}<p class="hint">Give a reason above to record this.</p>{/if}
					<button type="submit" disabled={!otherReady}>Record XP</button>
				</fieldset>
			</form>
		</details>

		<details class="sub">
			<summary>XP history ({char.xpLedger.entries.length})</summary>
			<p class="hint">Opening balance: {char.xpLedger.openingBalance}. History starts when XP tracking was added; this is not lifetime XP.</p>
			<ol reversed>
				{#each [...char.xpLedger.entries].reverse() as entry (entry.id)}
					<li>
						<strong>{entry.delta > 0 ? '+' : ''}{entry.delta} XP, {entry.sourceLabel}</strong>
						{#if entry.reason !== entry.sourceLabel}<p>{entry.reason}</p>{/if}
						{#if entry.talentBefore && entry.talentAfter}
							<p class="hint">Progress: {entry.talentBefore.xp} → {entry.talentAfter.xp} XP, {entry.talentBefore.state} → {entry.talentAfter.state}<br />Prepared uses: {entry.talentBefore.preparedUses ?? 'unknown'} → {entry.talentAfter.preparedUses ?? 'unknown'}</p>
						{/if}
						<small>{entry.at.slice(0, 10)}{entry.sessionLabel ? `, ${entry.sessionLabel}` : ''}</small>
					</li>
				{/each}
			</ol>
		</details>
	</details>
</section>

<style>
	.experience { margin: 1rem 0; padding: 0.6rem 1rem; border: 1px solid color-mix(in oklch, var(--ink) 20%, transparent); border-radius: 4px; transition: border-color 0.15s; }
	.experience:has(> details > .toggle:hover) { border-color: var(--accent); }
	summary { cursor: pointer; }
	/* The whole header row is the toggle: it bleeds to the box edge so the hover tint fills it. */
	.toggle { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.3rem 1rem; list-style: none; margin: -0.6rem -1rem; padding: 0.6rem 1rem; border-radius: 3px; transition: background-color 0.15s; }
	.toggle::-webkit-details-marker { display: none; }
	.toggle:hover { background: color-mix(in oklch, var(--accent) 7%, transparent); }
	.toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
	details[open] > .toggle { margin-bottom: 0; }
	.cta { margin-left: auto; display: inline-flex; align-items: center; gap: 0.35rem; font-family: var(--font-subhead); font-size: 0.85rem; color: var(--accent); }
	.chevron { transition: transform 0.15s; }
	details[open] > .toggle .chevron { transform: rotate(180deg); }
	@media (prefers-reduced-motion: reduce) { .experience, .toggle, .chevron { transition: none; } }
	h2 { margin: 0; font-size: 1.2rem; }
	h3 { margin: 0 0 0.4rem; font-size: 1rem; }
	.balance { font-family: var(--font-heading); font-size: 1.05rem; }
	fieldset { border: 0; margin: 0.8rem 0 0; padding: 0; display: grid; gap: 0.7rem; min-width: 0; }
	.chips { display: flex; flex-wrap: wrap; gap: 0.4rem; }
	.award { min-height: 2.75rem; padding: 0.4rem 0.8rem; font: inherit; font-size: 0.95rem; color: var(--ink); background: transparent; border: 1px solid color-mix(in oklch, var(--accent) 55%, transparent); border-radius: 3px; cursor: pointer; }
	.award:hover:not(:disabled) { background: color-mix(in oklch, var(--accent) 8%, transparent); }
	.award .plus { font-family: var(--font-subhead); font-variant-numeric: lining-nums; color: var(--accent); }
	.notes { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 0.6rem; }
	label { display: grid; gap: 0.2rem; font-size: 0.9rem; }
	input, select { width: 100%; min-width: 0; box-sizing: border-box; font: inherit; padding: 0.5rem; color: var(--ink); background: var(--parchment); border: 1px solid color-mix(in oklch, var(--ink) 25%, transparent); border-radius: 3px; }
	button[type='submit'] { justify-self: start; min-height: 2.75rem; font: inherit; padding: 0.5rem 0.9rem; color: var(--parchment); background: var(--accent); border: 0; border-radius: 3px; cursor: pointer; }
	button:disabled { opacity: 0.5; cursor: default; }
	.hint, small { color: var(--ink-soft); font-size: 0.82rem; }
	.hint, .preview { margin: 0; }
	.sub { margin-top: 0.9rem; }
	.sub > summary { font-family: var(--font-subhead); color: var(--accent); }
	.earns { margin: 0.5rem 0 0; }
	.earns dt { font-family: var(--font-subhead); }
	.earns dd { margin: 0 0 0.5rem; color: var(--ink-soft); font-size: 0.9rem; }
	li { margin: 0.7rem 0; overflow-wrap: anywhere; }
	li p { margin: 0.2rem 0; }
	@media (max-width: 30rem) { .notes { grid-template-columns: minmax(0, 1fr); } }
	@media (pointer: coarse) {
		.sub > summary { display: flex; align-items: center; min-height: 44px; }
		input, select, .award, button[type='submit'] { min-height: 44px; }
	}
</style>
