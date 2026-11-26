<script lang="ts">
	import { untrack } from 'svelte';
	import { beforeNavigate, invalidateAll } from '$app/navigation';
	import SheetHeader from '$lib/components/character/SheetHeader.svelte';
	import SuitFlourish from '$lib/components/decoration/SuitFlourish.svelte';
	import { flourishes } from '$lib/stores/flourishes';
	import SheetActions from '$lib/components/character/SheetActions.svelte';
	import StatusPanel from '$lib/components/character/edit/StatusPanel.svelte';
	import StoryEdit from '$lib/components/character/edit/StoryEdit.svelte';
	import TalentsEdit from '$lib/components/character/edit/TalentsEdit.svelte';
	import LanguagesEdit from '$lib/components/character/edit/LanguagesEdit.svelte';
	import ExperiencePanel from '$lib/components/character/ExperiencePanel.svelte';
	import SpellComponentsEdit from '$lib/components/character/edit/SpellComponentsEdit.svelte';
	import { applyXpAction, type XpAction } from '$lib/engine/experience';
	import GearPanel from '$lib/components/character/GearPanel.svelte';
	import RulesSidePanel from '$lib/components/rules/RulesSidePanel.svelte';
	import { createRulesSidePanel } from '$lib/components/rules/rules-side-panel.svelte';
	import { RULES_PANEL_MEDIA_QUERY } from '$lib/components/rules/rules-panel-layout';
	import { MediaQuery } from 'svelte/reactivity';
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
		// The server copy replaced the working copy: nothing local is left to undo.
		baseline = JSON.stringify(data.character);
		clearUndo();
	});

	// Rules panel state lives here, not in the panel, so the query and open
	// rule survive the panel unmounting when the window narrows. packVersion is
	// fixed for the life of the page.
	const rulesPanel = createRulesSidePanel(untrack(() => data.packVersion));
	// False during SSR: the panel mounts after hydration. Its grid column is
	// reserved by the CSS media query below, so the sheet does not move.
	const wide = new MediaQuery(RULES_PANEL_MEDIA_QUERY);

	// A count, not a boolean: overlapping saves (a flush for the adventurer
	// being left plus a fresh save here) must not clear each other's flag.
	let savingCount = $state(0);
	const saving = $derived(savingCount > 0);
	let saveError = $state('');
	let statusTimer: ReturnType<typeof setTimeout> | null = null;
	// A change is waiting out its debounce. statusTimer itself is not reactive.
	let dirty = $state(false);
	let savedOnce = $state(false);
	// The drawing perched on Status is the suit of the adventurer's own path;
	// the other three take Talents, Gear and Experience, in a fixed order.
	const SUITS = ['swords', 'wands', 'pentacles', 'cups'] as const;
	const perchSuits = $derived.by(() => {
		// The pack says which suit a path is aligned to; never read it off the id.
		const aligned = data.content.paths.find((path) => path.id === char.pathId)?.suit;
		const own = SUITS.find((suit) => suit === aligned);
		return own ? [own, ...SUITS.filter((suit) => suit !== own)] : [...SUITS];
	});

	// The pinned header's height: jump links land below it, and the rules
	// panel starts below it, level with the first sheet box.
	let stickyHeight = $state(0);
	const saveBusy = $derived(dirty || saving);
	const saveStateText = $derived(
		saveBusy ? 'Saving…' : saveError ? 'Not saved' : savedOnce ? 'Saved' : 'Changes save as you make them'
	);

	// One step of undo. `baseline` is the working copy as of the last save that
	// was sent (or the last server copy taken); a new burst of changes offers
	// it back until the next burst, an XP record, or the offer times out.
	const UNDO_OFFER_MS = 12_000;
	let baseline = untrack(() => JSON.stringify(data.character));
	let undoSnapshot = $state<string | null>(null);
	let undoTimer: ReturnType<typeof setTimeout> | null = null;
	function clearUndo() {
		if (undoTimer) clearTimeout(undoTimer);
		undoTimer = null;
		undoSnapshot = null;
	}
	function offerUndo(snapshot: string) {
		clearUndo();
		undoSnapshot = snapshot;
		undoTimer = setTimeout(clearUndo, UNDO_OFFER_MS);
	}
	function undoLastChange() {
		if (!undoSnapshot || recordingXp || syncRequired) return;
		const snapshot = undoSnapshot;
		clearUndo();
		if (statusTimer) clearTimeout(statusTimer);
		statusTimer = null;
		dirty = false;
		char = JSON.parse(snapshot) as GuildBookCharacterData;
		void persist();
	}

	const talentNames = $derived(new Map(data.content.talents.map((t) => [t.id, t.name])));
	const talentName = (id: string) => talentNames.get(id);

	// Jump links to each part of the sheet, in reading order.
	const sections = [
		{ id: 'sheet-status', label: 'Status' },
		{ id: 'sheet-talents', label: 'Talents' },
		{ id: 'sheet-gear', label: 'Gear' },
		{ id: 'sheet-experience', label: 'Experience' },
		{ id: 'sheet-spells', label: 'Spell components' },
		{ id: 'sheet-story', label: 'Story' },
		{ id: 'sheet-languages', label: 'Languages' },
		{ id: 'sheet-actions', label: 'Export & share' }
	];

	// 'ok': saved. 'stale': saved (or superseded) for an adventurer we've left —
	// nothing to react to. 'uncertain': 409 or network failure — the true
	// state is unknown until reloaded. 'rejected': a clean 4xx — the server
	// definitely never stored this, safe to just revert locally.
	type SaveOutcome = 'ok' | 'stale' | 'uncertain' | 'rejected';

	// Under the browsers' 64 KiB keepalive cap, with headroom for headers.
	const KEEPALIVE_BODY_LIMIT = 60_000;

	// Whether the most recent save was refused as a version conflict (409). A
	// conflict is uncertain about the document, but certain about our write:
	// it was not stored.
	let lastSaveConflicted = false;
	let saveChain: Promise<SaveOutcome> = Promise.resolve('ok');
	const savedVersions = new Map<string, number>();
	function persist(opts: { navigationFlush?: boolean } = {}): Promise<SaveOutcome> {
		const id = data.id;
		const snapshot = JSON.stringify(char);
		const version = serverVersion;
		baseline = snapshot;
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
		lastSaveConflicted = false;
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
				savedOnce = true;
				await invalidateAll();
				return 'ok';
			}
			if (res.status === 409) {
				lastSaveConflicted = true;
				if (stale()) return 'stale'; // that adventurer's page will refetch on open
				savedVersions.delete(id);
				saveError = 'This adventurer changed elsewhere — reloading the latest version. Check that your last change was saved.';
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
			saveError = 'Save could not be confirmed. Reloading the latest version — check that your last change was saved.';
			savedVersions.delete(id);
			forceResync = true;
			await invalidateAll().catch(() => {});
			return 'uncertain';
		} finally {
			savingCount -= 1;
		}
	}

	/** Every change on the sheet saves itself, debounced so a burst is one save. */
	function onSheetChange() {
		if (statusTimer) clearTimeout(statusTimer);
		// The first change of a burst: what the sheet held before it is the undo.
		else offerUndo(baseline);
		dirty = true;
		statusTimer = setTimeout(() => {
			statusTimer = null; // an expired handle is not a pending save
			dirty = false;
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
		clearUndo();
		if (!statusTimer) return;
		clearTimeout(statusTimer);
		statusTimer = null;
		dirty = false;
		void persist({ navigationFlush: true });
	});

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
			baseline = JSON.stringify(row.data);
			clearUndo();
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
		// A save in flight is waited for below (saveChain), not refused: a tap on
		// a talent's XP button during an autosave must still take effect.
		if (recordingXp || syncRequired) return false;
		const id = data.id;
		recordingXp = true;
		try {
			if (statusTimer) {
				clearTimeout(statusTimer); statusTimer = null; dirty = false;
				if ((await persist()) !== 'ok' || id !== data.id) return false;
			}
			// The ledger only moves forward: an earlier change can no longer be
			// taken back by restoring a copy from before this record.
			clearUndo();
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
			// A prepared use writes no ledger entry, so it cannot be recognised
			// by one afterwards; remember the count it should leave instead.
			const preparedAfter =
				action.kind === 'prepared-use'
					? result.character.talents.find((t) => t.talentId === action.talentId)?.preparedUses
					: undefined;
			const outcome = await persist();
			if (outcome === 'ok' || id !== data.id) return outcome === 'ok';
			if (outcome === 'uncertain') {
				// Genuinely don't know whether this landed — the authoritative
				// document, not a guess, decides whether it needs recording again.
				// Read before the reload issues requests of its own.
				const conflicted = lastSaveConflicted;
				const reloaded = await reloadCharacter();
				// A prepared use leaves no entry to look for. A conflict means it
				// was refused, whatever the count now reads (another tab may have
				// spent the same use); otherwise the count is the only evidence.
				const landed =
					action.kind === 'prepared-use'
						? !conflicted && char.talents.find((t) => t.talentId === action.talentId)?.preparedUses === preparedAfter
						: char.xpLedger.entries.some((entry) => entry.id === recordId);
				if (reloaded && landed) {
					saveError = '';
					return true;
				}
				return false;
			}
			// A clean rejection (e.g. a validation error) means the server never
			// stored this — revert the optimistic change locally. No reload or
			// lock is needed: nothing about the saved state is in question.
			char = beforeAction;
			// persist() took the rejected copy as the undo baseline; put the real
			// one back, or the next Undo would restore the award the server refused.
			baseline = JSON.stringify(beforeAction);
			return false;
		} finally { recordingXp = false; }
	}

	/**
	 * Store anything still pending and wait for it, so page data is current.
	 * False when the latest save did not succeed: the page data is then older
	 * than the sheet on screen, and the save panel already says why.
	 */
	async function flushSaves(): Promise<boolean> {
		if (statusTimer) {
			clearTimeout(statusTimer);
			statusTimer = null;
			dirty = false;
			void persist();
		}
		const outcome = await saveChain;
		if (outcome === 'ok') return true;
		if (!saveError) saveError = 'Not exported: the latest change has not been saved yet.';
		return false;
	}

	/** Promote a draft to a finished adventurer (server validates completeness). */
	async function finalize() {
		if (statusTimer) clearTimeout(statusTimer);
		statusTimer = null;
		dirty = false;
		// An undo offered before finalizing would restore a draft copy.
		clearUndo();
		char.isDraft = false;
		const outcome = await persist();
		// Only a clean rejection is known not to have been stored. After an
		// uncertain save the reload decides; forcing draft here could undo a
		// finalize that did land.
		if (outcome === 'rejected') {
			char.isDraft = true; // rejected (e.g. incomplete) — stay a draft locally
			baseline = JSON.stringify(char);
			saveError = saveError.replace('Creation-rule violation: ', 'Still missing: ');
		}
	}
</script>

<svelte:head><title>{data.view.name} — Guild Book</title></svelte:head>

<div class="sheet-page" style:--sticky-h="{stickyHeight}px">
	<div class="sheet-head">
	<div class="topbar">
		<p class="crumb"><a href="/characters">← My Adventurers</a></p>
		<p class="save-state" class:failed={!!saveError && !saveBusy} role="status">{saveStateText}</p>
	</div>

	{#if data.isDraft}
		<div class="draft-bar">
			<p class="draft-note">
				This adventurer is a <strong>draft</strong>. Finalize it to enable sharing.
			</p>
			<button type="button" class="finalize" disabled={saving || recordingXp || syncRequired} onclick={finalize}>Finalize</button>
		</div>
	{/if}
	</div>
	<div class="sheet-col">
	<!-- Inside the tall column, not the short head above it: a sticky box only
	     travels as far as its parent does. -->
	<div class="sheet-sticky" bind:offsetHeight={stickyHeight}>
		<SheetHeader name={char.name} pronouns={char.pronouns} view={data.view} flourishes={$flourishes} />
		<nav class="sections" aria-label="Sections">
			<ul>
				{#each sections as s (s.id)}
					<li><a href="#{s.id}">{s.label}</a></li>
				{/each}
			</ul>
		</nav>
	</div>

	<fieldset id="sheet-status" class="play-controls jump perch boxed" disabled={recordingXp || syncRequired}>
	{#if $flourishes}<span class="perched"><SuitFlourish suit={perchSuits[0]} scene /></span>{/if}
	<StatusPanel
		bind:char
		conditions={data.content.conditions}
		afflictions={data.content.afflictions}
		bondTypes={data.content.bondTypes}
		items={data.content.items}
		resolveMax={data.content.resolveMax}
		{talentName}
		onChange={onSheetChange}
	/>
	</fieldset>
	<fieldset class="play-controls" disabled={recordingXp || syncRequired}>
		<section id="sheet-talents" class="edit-section jump perch">
			{#if $flourishes}<span class="perched"><SuitFlourish suit={perchSuits[1]} scene /></span>{/if}
			<h2>Talents</h2>
			<TalentsEdit
				bind:char
				talents={data.content.talents}
				masteryXp={data.content.advancement.masteryXp}
				pathUseXp={data.content.advancement.pathUseXp}
				paths={data.content.paths}
				onChange={onSheetChange}
				onXpAction={recordXp}
			/>
		</section>
	</fieldset>
	<!-- Not a disabled fieldset: the panel locks its own controls, so its
	     custom-item form keeps taking input while an earlier change saves. -->
	<div id="sheet-gear" class="gear-wrap jump perch boxed aside">
		{#if $flourishes}<span class="perched"><SuitFlourish suit={perchSuits[2]} scene /></span>{/if}
		<GearPanel bind:char items={data.content.items} encumbrance={data.content.encumbrance} onChange={onSheetChange} locked={recordingXp || syncRequired} {saving} />
	</div>
	<div id="sheet-experience" class="jump perch mid">
		{#if $flourishes}<span class="perched"><SuitFlourish suit={perchSuits[3]} scene /></span>{/if}
		<ExperiencePanel {char} config={data.content.advancement} disabled={saving || recordingXp || syncRequired} onAction={recordXp} />
	</div>

	<fieldset class="play-controls" disabled={recordingXp || syncRequired}>
		<section id="sheet-spells" class="edit-section jump">
			<h2>Spell components</h2>
			<SpellComponentsEdit bind:char spells={data.content.spells} config={data.content.sorcery} onChange={onSheetChange} />
		</section>
		<section id="sheet-story" class="edit-section jump">
			<h2>Story</h2>
			<StoryEdit bind:char motifCount={data.content.motifCount} onChange={onSheetChange} />
		</section>
		<section id="sheet-languages" class="edit-section jump">
			<h2>Languages</h2>
			<LanguagesEdit bind:char languages={data.content.languages} onChange={onSheetChange} />
		</section>
	</fieldset>

	<div id="sheet-actions" class="actions-wrap jump">
		<SheetActions view={data.view} characterId={data.id} shareId={data.shareId} isDraft={data.isDraft} beforeExport={flushSaves} />
		<!-- Decoration is a preference, kept on this device; it sits with the
		     sheet's other housekeeping, out of the way of play. -->
		<button type="button" class="flourish-toggle" aria-pressed={$flourishes} onclick={() => flourishes.update((on) => !on)}>
			Tarot drawings: {$flourishes ? 'on' : 'off'}
		</button>
	</div>
	</div>
	{#if wide.current}
		<RulesSidePanel panel={rulesPanel} />
	{/if}
</div>

<!-- Fixed to the viewport: a failed save or an undo offer has to be seen from
     wherever on the sheet the change was made. -->
{#if saveError || syncRequired || undoSnapshot}
	<div class="save-dock">
		{#if saveError}<p class="error" role="alert">{saveError}</p>{/if}
		{#if syncRequired}
			<p>Reload the saved adventurer before recording another change.</p>
			<button type="button" onclick={() => reloadCharacter()}>Retry reload</button>
		{:else if undoSnapshot}
			<button type="button" disabled={recordingXp} onclick={undoLastChange}>Undo last change</button>
		{/if}
	</div>
{/if}

<style>
	.play-controls { border: 0; padding: 0; margin: 0; min-width: 0; }
	/* A jumped-to section lands with breathing room above it. */
	.jump { scroll-margin-top: calc(var(--sticky-h, 0px) + 1rem); }
	.sheet-sticky {
		position: sticky;
		top: 0;
		z-index: 10;
		padding: 0.6rem 0 0.5rem;
		background: var(--parchment);
		border-bottom: 1px solid color-mix(in oklab, var(--ink) 30%, transparent);
	}
	.sections {
		margin: 0.5rem 0 0;
	}
	/* One row that scrolls sideways, so the pinned header keeps its height. */
	.sections ul {
		display: flex;
		gap: 0.4rem;
		margin: 0;
		padding: 2px;
		list-style: none;
		overflow-x: auto;
		scrollbar-width: none;
	}
	.sections ul::-webkit-scrollbar {
		display: none;
	}
	.sections li {
		flex: none;
	}
	.sections a {
		display: inline-block;
		padding: 0.2rem 0.7rem;
		border: 1px solid color-mix(in oklab, var(--ink) 20%, transparent);
		border-radius: 999px;
		font-family: var(--font-subhead);
		font-size: 0.85rem;
		color: var(--ink);
		text-decoration: none;
	}
	.sections a:hover,
	.sections a:focus-visible {
		border-color: var(--accent);
		color: var(--accent);
		background: color-mix(in oklab, var(--accent) 7%, transparent);
	}
	/* A block formatting context, as the fieldset it replaced was: margins don't collapse through it. */
	.gear-wrap { display: flow-root; min-width: 0; }
	.sheet-page {
		max-width: 48rem;
		margin: 0 auto;
		/* A sheet is read as numbers: lining digits throughout. */
		--font-body: var(--font-body-figures);
		--font-heading: var(--font-heading-figures);
		font-family: var(--font-body);
	}
	@media (pointer: coarse) {
		.sections a {
			display: inline-flex;
			align-items: center;
			min-height: 44px;
		}
	}
	.sheet-head,
	.sheet-col {
		min-width: 0;
	}
	/* Wide screens: the sheet column and the rules panel side by side. The grid
	 * is CSS-only (not gated on the MediaQuery) so the column is reserved
	 * before hydration mounts the panel. 84rem = RULES_PANEL_MEDIA_QUERY
	 * ($lib/components/rules/rules-panel-layout), the first width where the
	 * sheet keeps its full 48rem. The sheet track's minimum is 48rem (so the
	 * panel, not the sheet, gives up spare width), capped at what is left after
	 * the panel's 22rem and the gap, so an unusual browser font size can never
	 * push the page into horizontal scroll. */
	@media (min-width: 84rem) {
		.sheet-page {
			max-width: none;
			display: grid;
			grid-template-columns: minmax(min(48rem, 100% - 24rem), 48rem) minmax(22rem, 28rem);
			column-gap: 2rem;
			justify-content: center;
			align-items: start;
		}
		/* The breadcrumb / Edit row gets its own grid row so the rules panel
		 * starts level with the first sheet box, not with that row. */
		.sheet-head,
		.sheet-col {
			grid-column: 1;
		}
		.sheet-page > :global(.rules-panel) {
			grid-column: 2;
			grid-row: 2;
			/* Below the pinned header, then the Status panel's own top margin. */
			margin-top: calc(var(--sticky-h, 0px) + 1.25rem);
		}
	}
	.topbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem 1rem;
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
	.save-state {
		margin: 0 0 0 auto;
		order: 0;
		font-family: var(--font-subhead);
		font-size: 0.9rem;
		color: var(--ink-soft);
	}
	.save-state.failed {
		color: var(--danger);
	}
	.flourish-toggle {
		margin-top: 0.75rem;
		padding: 0.45rem 0.9rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 3px;
		background: transparent;
		color: var(--ink-soft);
		font-family: var(--font-subhead);
		font-size: 0.9rem;
		cursor: pointer;
	}
	.flourish-toggle[aria-pressed='true'] {
		color: var(--ink);
	}
	/* A suit drawing perched on a section's top edge, as if on the frame. It
	 * sits at the right of the heading row, where nothing else lives. */
	.perch {
		position: relative;
	}
	.perched {
		position: absolute;
		/* Less than the gap above the section, so it never tucks under the
		 * pinned header or the box before it. */
		top: -1rem;
		right: 1.25rem;
		height: 6rem;
		pointer-events: none;
	}
	/* These wrappers hold a panel with its own 1.25rem top margin. */
	.perch.boxed > .perched {
		top: 0.25rem;
	}
	/* Gear's heading row ends in Auto-arrange; stand to its left. */
	.perch.aside > .perched {
		right: 9rem;
		/* Shorter: it must end above the first carrying-place band. */
		height: 4.2rem;
	}
	/* Experience is one short row ending in its toggle: stand in the gap
	 * before the toggle, and stay within the row's height. */
	.perch.mid > .perched {
		top: -1.9rem;
		right: 13rem;
		height: 4.2rem;
	}
	@media (max-width: 30rem) {
		.perched {
			height: 3.6rem;
			right: 0.75rem;
		}
		.perch.aside > .perched {
			right: 8.5rem;
		}
		/* On a phone the toggle wraps to a second line, leaving the first
		 * line's right end free. */
		.perch.mid > .perched {
			/* Mostly in the gap above the box, clear of the XP figure. */
			top: -2.3rem;
			right: 0.75rem;
			height: 3.2rem;
		}
	}
	@media (pointer: coarse) {
		.flourish-toggle {
			min-height: 44px;
		}
	}
	.save-dock button {
		min-height: 2.75rem;
		padding: 0.45rem 1.1rem;
		border: 1px solid var(--accent);
		border-radius: 3px;
		background: transparent;
		color: var(--accent);
		font-family: var(--font-subhead);
		font-size: 0.95rem;
		cursor: pointer;
	}
	.save-dock button:disabled {
		opacity: 0.55;
	}
	.save-dock {
		position: fixed;
		right: 1rem;
		bottom: 1rem;
		z-index: 20;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.6rem 1rem;
		max-width: min(30rem, calc(100% - 2rem));
		padding: 0.6rem 0.75rem 0.6rem 1rem;
		border: 1px solid color-mix(in oklab, var(--ink) 30%, transparent);
		border-radius: 4px;
		background: var(--parchment);
		box-shadow: 0 6px 18px -6px color-mix(in oklab, var(--ink) 45%, transparent);
	}
	.save-dock p {
		margin: 0;
		font-size: 0.9rem;
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
	.save-dock .error {
		color: var(--danger);
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
