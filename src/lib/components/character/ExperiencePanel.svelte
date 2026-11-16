<script lang="ts">
 import type { GuildBookCharacterData } from '$lib/types/character';
 import type { AdvancementConfig } from '$lib/types/content-pack';
 import type { XpAction } from '$lib/engine/experience';
 let { char, config, disabled = false, onAction }: {
  char: GuildBookCharacterData; config: AdvancementConfig; disabled?: boolean;
  onAction: (action: XpAction, reason: string, sessionLabel?: string) => Promise<boolean>;
 } = $props();
 let mode = $state('award');
 // Only the initial choice comes from the pack; the select owns it after.
 // svelte-ignore state_referenced_locally
 let source = $state(config.awards[0]?.id ?? '');
 let amount = $state(1);
 let reason = $state('');
 let session = $state('');
 let open = $state(false);
 const preset = $derived(config.awards.find(a => a.id === source));
 const delta = $derived(mode === 'award' ? (preset?.amount ?? amount) : mode === 'spend' ? -amount : amount);
 async function submit() {
  const action: XpAction = mode === 'award' ? { kind: 'award', presetId: source, ...(preset?.amount === null ? { amount } : {}) } : mode === 'spend' ? { kind: 'spend', amount } : { kind: 'correction', balanceDelta: amount };
  if (await onAction(action, reason, session || undefined)) { reason = ''; }
 }
</script>
<section aria-label="Experience" class="experience">
 <details bind:open>
 <summary class="toggle"><h2>Experience</h2><span class="balance">Available XP: {char.experience}</span><span class="cta">{open ? 'Hide' : 'Record XP & history'}<svg class="chevron" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg></span></summary>
 <form onsubmit={event => { event.preventDefault(); void submit(); }}>
  <fieldset disabled={disabled}>
   <label>XP action<select bind:value={mode}><option value="award">Award XP</option><option value="spend">Spend XP</option><option value="correction">Correct balance</option></select></label>
   {#if mode === 'award'}
    <label>XP source<select bind:value={source}>{#each config.awards as award}<option value={award.id}>{award.label}{award.amount !== null ? ` (+${award.amount})` : ''}</option>{/each}</select></label>
    {#if preset}<p class="hint">{preset.reminder}</p>{/if}
   {/if}
   {#if mode !== 'award' || preset?.amount === null}
    <label>{mode === 'correction' ? 'Balance adjustment' : 'XP amount'}<input type="number" step={mode === 'correction' ? 'any' : '1'} min={mode === 'correction' ? undefined : 1} required bind:value={amount} /></label>
   {/if}
   <label>Reason<input required maxlength="1000" bind:value={reason} placeholder="Quest, contract, or reason for this change" /></label>
   <label>Session (optional)<input maxlength="200" bind:value={session} /></label>
   <p class="preview">Available XP: {char.experience} → {char.experience + delta}</p>
   <button type="submit" disabled={!reason.trim() || !Number.isFinite(delta) || (mode === 'award' && !preset)}>Record XP</button>
  </fieldset>
 </form>
 <details open={char.xpLedger.entries.length > 0}>
  <summary>XP history ({char.xpLedger.entries.length})</summary>
  <p class="hint">Opening balance: {char.xpLedger.openingBalance}. History starts when XP tracking was added; this is not lifetime XP.</p>
  <ol reversed>
   {#each [...char.xpLedger.entries].reverse() as entry (entry.id)}
    <li><strong>{entry.delta > 0 ? '+' : ''}{entry.delta} XP · {entry.sourceLabel}</strong><p>{entry.reason}</p>{#if entry.talentBefore && entry.talentAfter}<p class="hint">Progress: {entry.talentBefore.xp} → {entry.talentAfter.xp} XP · {entry.talentBefore.state} → {entry.talentAfter.state}<br />Prepared uses: {entry.talentBefore.preparedUses ?? 'unknown'} → {entry.talentAfter.preparedUses ?? 'unknown'}</p>{/if}<small>{entry.at.slice(0, 10)}{entry.sessionLabel ? ` · ${entry.sessionLabel}` : ''}</small></li>
   {/each}
  </ol>
 </details>
 </details>
</section>
<style>
 .experience { margin: 1rem 0; padding: .6rem 1rem; border: 1px solid color-mix(in oklch, var(--ink) 20%, transparent); border-radius: 4px; transition: border-color .15s; }
 .experience:has(> details > .toggle:hover) { border-color: var(--accent); }
 summary { display: flex; align-items: baseline; gap: 1rem; cursor: pointer; }
 /* The whole header row is the toggle: it bleeds to the box edge so the hover tint fills it. */
 .toggle { list-style: none; flex-wrap: wrap; row-gap: .3rem; margin: -.6rem -1rem; padding: .6rem 1rem; border-radius: 3px; transition: background-color .15s; }
 .toggle::-webkit-details-marker { display: none; }
 .toggle:hover { background: color-mix(in oklch, var(--accent) 7%, transparent); }
 .toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
 details[open] > .toggle { margin-bottom: 0; }
 .cta { margin-left: auto; display: inline-flex; align-items: center; gap: .35rem; font-family: var(--font-subhead); font-size: .85rem; color: var(--accent); }
 .chevron { transition: transform .15s; }
 details[open] > .toggle .chevron { transform: rotate(180deg); }
 @media (prefers-reduced-motion: reduce) { .experience, .toggle, .chevron { transition: none; } }
 h2 { margin: 0; font-size: 1.2rem; } .balance { font-family: var(--font-heading); font-size: 1.05rem; }
 form { margin-top: .8rem; }
 fieldset { border: 0; margin: 0; padding: 0; display: grid; gap: .6rem; min-width: 0; }
 label { display: grid; gap: .2rem; font-size: .9rem; }
 input, select { width: 100%; min-width: 0; box-sizing: border-box; font: inherit; padding: .5rem; color: var(--ink); background: var(--parchment); border: 1px solid color-mix(in oklch, var(--ink) 25%, transparent); border-radius: 3px; }
 button { justify-self: start; font: inherit; padding: .5rem .9rem; color: var(--parchment); background: var(--accent); border: 0; border-radius: 3px; cursor: pointer; } button:disabled { opacity: .5; }
 .hint, small { color: var(--ink-soft); font-size: .82rem; } .preview { margin: .2rem 0; }
 details { margin-top: 1rem; } .experience > details { margin-top: 0; } summary { cursor: pointer; } li { margin: .7rem 0; overflow-wrap: anywhere; } li p { margin: .2rem 0; }
</style>
