<script lang="ts">
	import { untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import CharacterSheet from '$lib/components/character/CharacterSheet.svelte';
	import SheetActions from '$lib/components/character/SheetActions.svelte';
	import StatusPanel from '$lib/components/character/edit/StatusPanel.svelte';
	import StoryEdit from '$lib/components/character/edit/StoryEdit.svelte';
	import TalentsEdit from '$lib/components/character/edit/TalentsEdit.svelte';
	import GearEdit from '$lib/components/character/edit/GearEdit.svelte';
	import type { GuildBookCharacterData } from '$lib/types/character';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Local working copy, seeded once — the $effect below re-syncs it whenever
	// the server copy changes (post-save invalidateAll, or a 409 refetch).
	let char = $state<GuildBookCharacterData>(untrack(() => structuredClone(data.character)));
	let serverUpdatedAt = $state(untrack(() => data.updatedAt));
	$effect(() => {
		char = structuredClone(data.character);
		serverUpdatedAt = data.updatedAt;
	});

	let editMode = $state(false);
	let saving = $state(false);
	let saveError = $state('');
	let statusTimer: ReturnType<typeof setTimeout> | null = null;

	const talentNames = $derived(new Map(data.content.talents.map((t) => [t.id, t.name])));
	const talentName = (id: string) => talentNames.get(id) ?? id;

	async function persist() {
		saving = true;
		saveError = '';
		try {
			const res = await fetch(`/api/characters/${data.id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ character: char, expectedUpdatedAt: serverUpdatedAt })
			});
			if (res.ok) {
				const body = (await res.json()) as { updatedAt: number };
				serverUpdatedAt = body.updatedAt;
				await invalidateAll();
				return true;
			}
			if (res.status === 409) {
				saveError = 'This adventurer changed elsewhere — reloading the latest version.';
				await invalidateAll();
				return false;
			}
			const body = (await res.json().catch(() => ({}))) as { message?: string };
			saveError = body.message ?? 'Save failed.';
			return false;
		} catch {
			saveError = 'Network error — try again.';
			return false;
		} finally {
			saving = false;
		}
	}

	/** Status-panel changes save automatically (debounced) outside edit mode. */
	function onStatusChange() {
		if (editMode) return; // participates in the edit session instead
		if (statusTimer) clearTimeout(statusTimer);
		statusTimer = setTimeout(() => void persist(), 600);
	}

	function onEditChange() {
		// Edited fields wait for the explicit Save.
	}

	async function saveEdits() {
		if (await persist()) editMode = false;
	}

	function cancelEdits() {
		char = structuredClone(data.character);
		editMode = false;
		saveError = '';
	}

	/** Promote a draft to a finished adventurer (server validates completeness). */
	async function saveAsFinal() {
		char.isDraft = false;
		const ok = await persist();
		if (!ok) {
			char.isDraft = true; // rejected (e.g. incomplete) — stay a draft locally
			saveError = saveError.replace('Creation-rule violation: ', 'Still missing: ');
		}
	}
</script>

<svelte:head><title>{data.view.name} — Guild Book</title></svelte:head>

<div class="sheet-page">
	<div class="topbar">
		<p class="crumb"><a href="/characters">← My Adventurers</a></p>
		{#if !editMode}
			<button type="button" class="edit-toggle" onclick={() => (editMode = true)}>Edit</button>
		{:else}
			<div class="edit-actions">
				<button type="button" class="ghost" onclick={cancelEdits}>Cancel</button>
				<button type="button" class="primary" disabled={saving} onclick={saveEdits}>
					{saving ? 'Saving…' : 'Save changes'}
				</button>
			</div>
		{/if}
	</div>

	{#if data.isDraft}
		<div class="draft-bar">
			<p class="draft-note">
				This adventurer is a <strong>draft</strong> — finalize it to enable sharing.
			</p>
			<button type="button" class="finalize" disabled={saving} onclick={saveAsFinal}>
				{saving ? 'Saving…' : 'Save as final'}
			</button>
		</div>
	{/if}
	{#if saveError}<p class="error">{saveError}</p>{/if}

	<StatusPanel
		bind:char
		conditions={data.content.conditions}
		afflictions={data.content.afflictions}
		items={data.content.items}
		resolveMax={data.content.resolveMax}
		{talentName}
		onChange={onStatusChange}
	/>

	{#if editMode}
		<section class="edit-section">
			<h2>Story</h2>
			<StoryEdit bind:char motifCount={data.content.motifCount} onChange={onEditChange} />
		</section>
		<section class="edit-section">
			<h2>Talents</h2>
			<TalentsEdit bind:char talents={data.content.talents} onChange={onEditChange} />
		</section>
		<section class="edit-section">
			<h2>Gear</h2>
			<GearEdit
				bind:char
				items={data.content.items}
				encumbrance={data.content.encumbrance}
				onChange={onEditChange}
			/>
		</section>
	{:else}
		<CharacterSheet view={data.view} />
	{/if}

	<div class="actions-wrap">
		<SheetActions view={data.view} characterId={data.id} shareId={data.shareId} isDraft={data.isDraft} />
	</div>
</div>

<style>
	.sheet-page {
		max-width: 48rem;
		margin: 0 auto;
	}
	.topbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}
	.crumb {
		font-family: var(--font-subhead);
		font-size: 0.9rem;
		margin: 0;
	}
	.crumb a {
		color: var(--ink-soft);
		text-decoration: none;
	}
	.edit-toggle,
	.edit-actions .primary,
	.edit-actions .ghost {
		padding: 0.45rem 1.1rem;
		border-radius: 3px;
		font-family: var(--font-subhead);
		font-size: 0.95rem;
		cursor: pointer;
		border: 1px solid var(--accent);
	}
	.edit-toggle,
	.edit-actions .primary {
		background: var(--accent);
		color: var(--parchment);
	}
	.edit-actions .ghost {
		background: transparent;
		color: var(--accent);
	}
	.edit-actions {
		display: flex;
		gap: 0.5rem;
	}
	.edit-actions .primary:disabled {
		opacity: 0.55;
	}
	.draft-bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		margin: 0.75rem 0;
		padding: 0.7rem 1rem;
		border: 1px solid color-mix(in oklab, var(--accent) 45%, transparent);
		border-radius: 4px;
		background: color-mix(in oklab, var(--accent) 6%, var(--parchment));
	}
	.draft-note {
		margin: 0;
		color: var(--ink-soft);
		font-size: 0.9rem;
	}
	.finalize {
		padding: 0.5rem 1.1rem;
		border: 1px solid var(--accent);
		border-radius: 3px;
		background: var(--accent);
		color: var(--parchment);
		font-family: var(--font-subhead);
		font-size: 1rem;
		cursor: pointer;
	}
	.finalize:disabled {
		opacity: 0.55;
	}
	.error {
		color: var(--accent);
		font-size: 0.9rem;
	}
	.edit-section {
		margin: 1.25rem 0;
		padding: 1rem 1.1rem;
		border: 1px solid color-mix(in oklab, var(--ink) 18%, transparent);
		border-radius: 4px;
	}
	.edit-section h2 {
		margin: 0 0 0.7rem;
		font-size: 1.05rem;
	}
	.actions-wrap {
		margin-top: 1.25rem;
	}
</style>
