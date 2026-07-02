<script lang="ts">
	import { goto } from '$app/navigation';
	import { wizard, WIZARD_STEPS } from '$lib/stores/wizard';
	import { SUIT_IDS, SUIT_LABELS } from '$lib/types/common';
	import type { PageData } from './$types';

	const STEP = 7;
	let { data }: { data: PageData } = $props();

	let char = $derived($wizard.character);

	const kithName = (id: string | null) => data.kiths.find((k) => k.id === id)?.name ?? null;
	const kinName = (id: string | null) =>
		data.kiths.flatMap((k) => k.kins).find((k) => k.id === id)?.name ?? null;
	const pathObj = $derived(data.paths.find((p) => p.id === char.pathId) ?? null);
	const talentName = (id: string) => data.talents.find((t) => t.id === id)?.name ?? id;
	const itemName = (id: string | null) => data.items.find((i) => i.id === id)?.name ?? 'Item';

	// Client-side mirror of the server's final-validation gate.
	let problems = $derived.by(() => {
		const p: string[] = [];
		if (!char.name.trim()) p.push('Give your adventurer a name.');
		if (!char.kithId || !char.kinId) p.push('Choose a kith and kin.');
		if (!char.pathId) p.push('Choose a path.');
		const values = SUIT_IDS.map((s) => char.attributes[s]?.value ?? 0).sort((a, b) => a - b);
		const spread = [...data.contentPack.creation.attributeSpread].sort((a, b) => a - b);
		if (JSON.stringify(values) !== JSON.stringify(spread)) p.push('Assign your attribute spread.');
		else if (pathObj) {
			const highest = Math.max(...spread);
			const highestSuit = SUIT_IDS.find((s) => char.attributes[s]?.value === highest);
			if (highestSuit && highestSuit !== pathObj.suit) {
				p.push(`Your highest attribute must be ${pathObj.suit}.`);
			}
		}
		return p;
	});

	let saving = $state(false);
	let errorMsg = $state('');

	async function save(asDraft: boolean) {
		saving = true;
		errorMsg = '';
		const character = { ...$wizard.character, isDraft: asDraft, wizardStep: STEP };
		try {
			const res = await fetch('/api/characters', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ character })
			});
			if (res.status === 401) {
				goto('/login?callbackUrl=/characters');
				return;
			}
			if (res.status === 201) {
				// Navigate away from the wizard route BEFORE resetting. Resetting
				// while still on a /create/hmtw/* route flips `active` to false and
				// trips WizardShell's deep-link guard, which restarts the wizard and
				// redirects to the first step — racing (and beating) this goto.
				await goto('/characters');
				wizard.reset();
				return;
			}
			const body = (await res.json().catch(() => ({ message: 'Save failed.' }))) as {
				message?: string;
			};
			errorMsg = body.message ?? 'Save failed.';
		} catch {
			errorMsg = 'Network error — try again.';
		} finally {
			saving = false;
		}
	}
</script>

<svelte:head><title>Review — Guild Book</title></svelte:head>

<h1>{char.name || 'Your adventurer'}</h1>
<p class="sub">
	{#if kinName(char.kinId)}<span>{kinName(char.kinId)} ({kithName(char.kithId)})</span>{/if}
	{#if pathObj}<span>{pathObj.name}</span>{/if}
</p>

<section class="attrs">
	{#each SUIT_IDS as s (s)}
		<div><span class="v">{char.attributes[s]?.value ?? 0}</span><span class="n">{SUIT_LABELS[s]}</span></div>
	{/each}
</section>

{#if char.talents.length}
	<section><h2>Talents</h2>
		<ul>{#each char.talents as t}<li>{talentName(t.talentId)} <em>({t.state})</em></li>{/each}</ul>
	</section>
{/if}
{#if char.quest}<section><h2>Quest</h2><p>{char.quest}</p></section>{/if}
{#if char.motifs.length}<section><h2>Motifs</h2><p>{char.motifs.join(' · ')}</p></section>{/if}
{#if char.equipment.length}
	<section><h2>Gear</h2>
		<ul class="inline">{#each char.equipment as e}<li>{itemName(e.itemId)}</li>{/each}</ul>
	</section>
{/if}

{#if problems.length}
	<div class="problems">
		<strong>Finish these to save a completed adventurer:</strong>
		<ul>{#each problems as p}<li>{p}</li>{/each}</ul>
	</div>
{/if}

{#if errorMsg}<p class="error">{errorMsg}</p>{/if}

<div class="save-row">
	<a class="back" href={WIZARD_STEPS[STEP - 1].path}>← Back</a>
	<button type="button" class="draft" disabled={saving} onclick={() => save(true)}>Save as draft</button>
	<button type="button" class="finish" disabled={saving || problems.length > 0} onclick={() => save(false)}>
		{saving ? 'Saving…' : 'Save adventurer'}
	</button>
</div>

<style>
	.sub {
		display: flex;
		gap: 0.75rem;
		color: var(--ink-soft);
		font-family: var(--font-subhead);
		margin-top: -0.25rem;
	}
	.attrs {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 0.75rem;
		margin: 1.25rem 0;
		max-width: 26rem;
	}
	.attrs div {
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 0.6rem;
		border: 1px solid color-mix(in oklab, var(--ink) 18%, transparent);
		border-radius: 4px;
	}
	.attrs .v {
		font-family: var(--font-display);
		font-size: 1.7rem;
		line-height: 1;
	}
	.attrs .n {
		font-size: 0.75rem;
		color: var(--ink-soft);
	}
	section {
		margin: 1rem 0;
	}
	h2 {
		font-size: 1rem;
		margin: 0 0 0.3rem;
		border-bottom: 1px solid color-mix(in oklab, var(--ink) 15%, transparent);
	}
	ul {
		margin: 0;
		padding-left: 1.1rem;
	}
	ul.inline {
		list-style: none;
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		padding: 0;
	}
	ul.inline li {
		padding: 0.1rem 0.5rem;
		border: 1px solid color-mix(in oklab, var(--ink) 18%, transparent);
		border-radius: 999px;
		font-size: 0.85rem;
	}
	.problems {
		margin: 1.25rem 0;
		padding: 0.9rem 1rem;
		border: 1px solid color-mix(in oklab, var(--accent) 45%, transparent);
		border-radius: 4px;
		background: color-mix(in oklab, var(--accent) 6%, var(--parchment));
		font-size: 0.9rem;
	}
	.error {
		color: var(--accent);
	}
	.save-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-top: 1.5rem;
	}
	.save-row .back {
		margin-right: auto;
		font-family: var(--font-subhead);
		color: var(--ink-soft);
		text-decoration: none;
	}
	.save-row button {
		padding: 0.6rem 1.2rem;
		border-radius: 3px;
		font-family: var(--font-subhead);
		font-size: 1.1rem;
		cursor: pointer;
	}
	.draft {
		border: 1px solid var(--accent);
		background: transparent;
		color: var(--accent);
	}
	.finish {
		border: 1px solid var(--accent);
		background: var(--accent);
		color: var(--parchment);
	}
	.save-row button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
