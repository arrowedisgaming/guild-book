<script lang="ts">
	import { untrack } from 'svelte';
	import { beforeNavigate, invalidateAll } from '$app/navigation';
	import CharacterSheet from '$lib/components/character/CharacterSheet.svelte';
	import SheetActions from '$lib/components/character/SheetActions.svelte';
	import StatusPanel from '$lib/components/character/edit/StatusPanel.svelte';
	import StoryEdit from '$lib/components/character/edit/StoryEdit.svelte';
	import TalentsEdit from '$lib/components/character/edit/TalentsEdit.svelte';
	import LanguagesEdit from '$lib/components/character/edit/LanguagesEdit.svelte';
	import GearEdit from '$lib/components/character/edit/GearEdit.svelte';
	import type { GuildBookCharacterData } from '$lib/types/character';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Local working copy, seeded once — the $effect below re-syncs it whenever
	// the server copy changes (a 409 refetch, or an edit made elsewhere).
	let char = $state<GuildBookCharacterData>(untrack(() => structuredClone(data.character)));
	let serverVersion = $state(untrack(() => data.version));
	let syncedId = $state(untrack(() => data.id));
	// Latched by a 409 until the resync below consumes it. Deliberately NOT
	// $state: the $effect must not wake on the latch itself — it would run
	// before invalidateAll delivers fresh data and consume the flag against
	// the stale copy. The effect already re-runs on every data replacement,
	// which is exactly when the latch is ready to be consumed. And a latch —
	// not a sentinel smuggled through serverVersion — survives a concurrent
	// save's late 200 overwriting serverVersion.
	let forceResync = false;
	$effect(() => {
		// A successful save already advanced serverVersion before invalidateAll
		// ran, so the reload that follows our own PUT arrives carrying the very
		// version we just wrote. Re-seeding char from it would throw away any
		// edit made during the save's round trip (the next debounced save would
		// then persist the rolled-back copy) — only a genuinely newer server
		// copy is worth taking. The id check is not optional: SvelteKit reuses
		// this component when only the [id] param changes, and two characters
		// can share a version number — without it, char would keep the previous
		// adventurer and the next save would write them over the new one.
		if (
			!forceResync &&
			data.id === untrack(() => syncedId) &&
			data.version === untrack(() => serverVersion)
		) {
			return;
		}
		forceResync = false;
		syncedId = data.id;
		char = structuredClone(data.character);
		serverVersion = data.version;
	});

	let editMode = $state(false);
	// A count, not a boolean: overlapping saves (a flush for the adventurer
	// being left plus a fresh save here) must not clear each other's flag.
	let savingCount = $state(0);
	const saving = $derived(savingCount > 0);
	let saveError = $state('');
	let statusTimer: ReturnType<typeof setTimeout> | null = null;

	const talentNames = $derived(new Map(data.content.talents.map((t) => [t.id, t.name])));
	const talentName = (id: string) => talentNames.get(id) ?? id;

	async function persist(opts: { keepalive?: boolean } = {}) {
		// Everything this request needs is captured NOW: a debounced save
		// flushed on navigation, or a response landing after the component was
		// reused for another adventurer, must neither address the wrong id nor
		// mutate the current character's sync state (a stale 409 setting
		// forceResync here would discard the new adventurer's unsaved edits).
		// Staleness is re-checked after every await — navigation can land
		// between the response headers and the parsed body.
		const id = data.id;
		const body = JSON.stringify({ character: char, expectedVersion: serverVersion });
		const stale = () => id !== data.id;
		savingCount += 1;
		saveError = '';
		try {
			const res = await fetch(`/api/characters/${id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body,
				keepalive: opts.keepalive ?? false
			});
			if (res.ok) {
				const resBody = (await res.json()) as { version: number };
				if (stale()) return false; // never touch the next adventurer's sync state
				serverVersion = resBody.version;
				await invalidateAll();
				return true;
			}
			if (res.status === 409) {
				if (stale()) return false; // that adventurer's page will refetch on open
				saveError = 'This adventurer changed elsewhere — reloading the latest version.';
				forceResync = true;
				await invalidateAll();
				return false;
			}
			const resBody = (await res.json().catch(() => ({}))) as { message?: string };
			if (!stale()) saveError = resBody.message ?? 'Save failed.';
			return false;
		} catch {
			if (!stale()) saveError = 'Network error — try again.';
			return false;
		} finally {
			savingCount -= 1;
		}
	}

	/** Status-panel changes save automatically (debounced) outside edit mode. */
	function onStatusChange() {
		if (editMode) return; // participates in the edit session instead
		if (statusTimer) clearTimeout(statusTimer);
		statusTimer = setTimeout(() => {
			statusTimer = null; // an expired handle is not a pending save
			void persist();
		}, 600);
	}

	// A pending debounce must not outlive its adventurer: flushed here, the
	// save still addresses the character being left (persist captures the id
	// and payload up front); left running, the timer would fire after the
	// resync and PUT the NEXT adventurer's data — losing the edit entirely.
	// keepalive lets the flush survive a full unload (reload, tab close),
	// where an ordinary fetch is torn down with the page.
	beforeNavigate(() => {
		if (!statusTimer) return;
		clearTimeout(statusTimer);
		statusTimer = null;
		void persist({ keepalive: true });
	});

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
		bondTypes={data.content.bondTypes}
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
			<h2>Languages</h2>
			<LanguagesEdit bind:char languages={data.content.languages} onChange={onEditChange} />
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
