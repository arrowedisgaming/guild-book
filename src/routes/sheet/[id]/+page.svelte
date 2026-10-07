<script lang="ts">
	import { untrack } from 'svelte';
	import { beforeNavigate, invalidateAll } from '$app/navigation';
	import CharacterSheet from '$lib/components/character/CharacterSheet.svelte';
	import SheetActions from '$lib/components/character/SheetActions.svelte';
	import StatusPanel from '$lib/components/character/edit/StatusPanel.svelte';
	import StoryEdit from '$lib/components/character/edit/StoryEdit.svelte';
	import TalentsEdit from '$lib/components/character/edit/TalentsEdit.svelte';
	import LanguagesEdit from '$lib/components/character/edit/LanguagesEdit.svelte';
	import ExperiencePanel from '$lib/components/character/ExperiencePanel.svelte';
	import SpellComponentsEdit from '$lib/components/character/edit/SpellComponentsEdit.svelte';
	import { applyXpAction, type XpAction } from '$lib/engine/experience';
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
		syncRequired = false;
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

	// 'ok': saved. 'stale': saved (or superseded) for an adventurer we've left —
	// nothing to react to. 'uncertain': 409 or network failure — the true
	// state is unknown until reloaded. 'rejected': a clean 4xx — the server
	// definitely never stored this, safe to just revert locally.
	type SaveOutcome = 'ok' | 'stale' | 'uncertain' | 'rejected';

	// Under the browsers' 64 KiB keepalive cap, with headroom for headers.
	const KEEPALIVE_BODY_LIMIT = 60_000;

	let saveChain: Promise<SaveOutcome> = Promise.resolve('ok');
	const savedVersions = new Map<string, number>();
	function persist(opts: { navigationFlush?: boolean } = {}): Promise<SaveOutcome> {
		const id = data.id;
		const snapshot = JSON.stringify(char);
		const version = serverVersion;
		const next = saveChain.then(() => persistSnapshot(id, snapshot, Math.max(savedVersions.get(id) ?? version, version), opts));
		saveChain = next.catch(() => 'rejected' as const);
		return next;
	}

	async function persistSnapshot(id: string, snapshot: string, expectedVersion: number, opts: { navigationFlush?: boolean } = {}): Promise<SaveOutcome> {
		// Everything this request needs is captured NOW: a debounced save
		// flushed on navigation, or a response landing after the component was
		// reused for another adventurer, must neither address the wrong id nor
		// mutate the current character's sync state (a stale 409 setting
		// forceResync here would discard the new adventurer's unsaved edits).
		// Staleness is re-checked after every await — navigation can land
		// between the response headers and the parsed body.
		const body = JSON.stringify({ character: JSON.parse(snapshot), expectedVersion });
		// A navigation flush must never invalidate the route being left: its save
		// can finish before the destination data arrives and cancel that navigation.
		const stale = () => id !== data.id || opts.navigationFlush === true;
		savingCount += 1;
		saveError = '';
		try {
			// Requested at the browser level (independent of whether THIS call is
			// a navigation flush) — it's the only thing standing between an
			// in-flight save, including a just-recorded XP action, and the browser
			// silently dropping it on a reload or tab close. Browsers reject
			// keepalive bodies over ~64 KiB outright, so a character whose XP
			// history has grown past that saves as an ordinary request instead.
			const res = await fetch(`/api/characters/${id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body,
				keepalive: new Blob([body]).size <= KEEPALIVE_BODY_LIMIT
			});
			if (res.ok) {
				const resBody = (await res.json()) as { version: number };
				savedVersions.set(id, resBody.version);
				if (stale()) return 'stale'; // never touch the next adventurer's sync state
				serverVersion = resBody.version;
				await invalidateAll();
				return 'ok';
			}
			if (res.status === 409) {
				if (stale()) return 'stale'; // that adventurer's page will refetch on open
				savedVersions.delete(id);
				saveError = 'This adventurer changed elsewhere — reloading the latest version. Check XP history before recording the action again.';
				forceResync = true;
				await invalidateAll();
				return 'uncertain';
			}
			const resBody = (await res.json().catch(() => ({}))) as { message?: string };
			if (stale()) return 'stale';
			saveError = resBody.message ?? 'Save failed.';
			return 'rejected';
		} catch {
			if (stale()) return 'stale';
			saveError = 'Save could not be confirmed. Reloading — check XP history before recording the action again.';
			savedVersions.delete(id);
			forceResync = true;
			await invalidateAll().catch(() => {});
			return 'uncertain';
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
	// navigationFlush keeps its response from touching this component's state
	// once we've moved on — the browser-level keepalive that lets the fetch
	// itself survive a full unload is requested for every save under the
	// size cap, inside persistSnapshot.
	beforeNavigate(() => {
		if (!statusTimer) return;
		clearTimeout(statusTimer);
		statusTimer = null;
		void persist({ navigationFlush: true });
	});

	function onEditChange() {
		// Edited fields wait for the explicit Save.
	}

	async function saveEdits() {
		if ((await persist()) === 'ok') editMode = false;
	}

	function cancelEdits() {
		char = structuredClone(data.character);
		editMode = false;
		saveError = '';
	}

	let recordingXp = $state(false);
	let syncRequired = $state(false);
	async function reloadCharacter(): Promise<boolean> {
		const id = data.id;
		syncRequired = true;
		try {
			const response = await fetch(`/api/characters/${id}`);
			if (!response.ok) return false;
			const row = await response.json() as { data: GuildBookCharacterData; version: number };
			if (id !== data.id) return false;
			char = row.data;
			serverVersion = row.version;
			savedVersions.set(id, row.version);
			forceResync = false;
			// The read-only sheet, exports, and Cancel read page data, not char:
			// refresh it too, or they keep showing the pre-recovery balance. The
			// resync effect sees the version we just took and leaves char alone.
			// A failure here falls to the catch: recovery isn't complete, so the
			// sheet stays locked (syncRequired) rather than unlocking half-stale.
			await invalidateAll();
			if (id !== data.id) return false;
			syncRequired = false;
			return true;
		} catch { return false; }
	}
	async function recordXp(action: XpAction, reason: string, sessionLabel?: string): Promise<boolean> {
		if (recordingXp || saving || syncRequired) return false;
		const id = data.id;
		recordingXp = true;
		try {
			if (statusTimer) {
				clearTimeout(statusTimer); statusTimer = null;
				if ((await persist()) !== 'ok' || id !== data.id) return false;
			}
			await saveChain;
			if (id !== data.id) return false;
			const beforeAction = $state.snapshot(char);
			const recordId = crypto.randomUUID();
			const result = applyXpAction(beforeAction, action, {
				id: recordId, at: new Date().toISOString(), reason, sessionLabel
			}, data.content);
			if (!result.ok) { saveError = result.error; return false; }
			char = result.character;
			saveError = '';
			if (editMode) return true;
			const outcome = await persist();
			if (outcome === 'ok' || id !== data.id) return outcome === 'ok';
			if (outcome === 'uncertain') {
				// Genuinely don't know whether this landed — the authoritative
				// document, not a guess, decides whether it needs recording again.
				const reloaded = await reloadCharacter();
				if (reloaded && char.xpLedger.entries.some((entry) => entry.id === recordId)) {
					saveError = '';
					return true;
				}
				return false;
			}
			// A clean rejection (e.g. a validation error) means the server never
			// stored this — revert the optimistic change locally. No reload or
			// lock is needed: nothing about the saved state is in question.
			char = beforeAction;
			return false;
		} finally { recordingXp = false; }
	}

	/** Promote a draft to a finished adventurer (server validates completeness). */
	async function saveAsFinal() {
		char.isDraft = false;
		const outcome = await persist();
		if (outcome !== 'ok') {
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
			<button type="button" class="edit-toggle" disabled={saving || recordingXp || syncRequired} onclick={() => (editMode = true)}>Edit</button>
		{:else}
			<div class="edit-actions">
				<button type="button" class="ghost" disabled={saving || recordingXp || syncRequired} onclick={cancelEdits}>Cancel</button>
				<button type="button" class="primary" disabled={saving || recordingXp || syncRequired} onclick={saveEdits}>
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
			<button type="button" class="finalize" disabled={saving || recordingXp || syncRequired} onclick={saveAsFinal}>
				{saving ? 'Saving…' : 'Save as final'}
			</button>
		</div>
	{/if}
	{#if saveError}<p class="error" role="alert">{saveError}</p>{/if}
	{#if syncRequired}<p>Reload the saved adventurer before recording another change.</p><button type="button" onclick={() => reloadCharacter()}>Retry reload</button>{/if}

	<fieldset class="play-controls" disabled={saving || recordingXp || syncRequired}>
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
	</fieldset>
	<ExperiencePanel {char} config={data.content.advancement} disabled={saving || recordingXp || syncRequired} onAction={recordXp} />

	{#if editMode}
		<fieldset class="play-controls" disabled={saving || recordingXp || syncRequired}>
		<section class="edit-section">
			<h2>Story</h2>
			<StoryEdit bind:char motifCount={data.content.motifCount} onChange={onEditChange} />
		</section>
		<section class="edit-section">
			<h2>Talents</h2>
			<TalentsEdit bind:char talents={data.content.talents} masteryXp={data.content.advancement.masteryXp} onChange={onEditChange} />
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
			<SpellComponentsEdit bind:char spells={data.content.spells} config={data.content.sorcery} onChange={onEditChange} />
		</section>
		</fieldset>
	{:else}
		<CharacterSheet view={data.view} />
	{/if}

	<div class="actions-wrap">
		<SheetActions view={data.view} characterId={data.id} shareId={data.shareId} isDraft={data.isDraft} />
	</div>
</div>

<style>
	.play-controls { border: 0; padding: 0; margin: 0; min-width: 0; }
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
