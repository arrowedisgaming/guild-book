<script lang="ts">
	import DenizenStatBlock from '$lib/components/denizens/DenizenStatBlock.svelte';
	import DenizenExportButtons from '$lib/components/denizens/DenizenExportButtons.svelte';
	import { denizenBuilder, builderPath } from '$lib/stores/denizen-builder';
	import {
		seedFromTemplates,
		needsReseed,
		toDenizenDefinition,
		draftStatWarnings,
		addPool,
		removePool,
		movePool,
		updatePool
	} from '$lib/engine/denizen-builder';
	import { renderMarkdown } from '$lib/utils/markdown';
	import { abilityLabel } from '$lib/utils/ability-label';
	import { announce } from '$lib/stores/announcer';
	import type { DenizenAbility } from '$lib/types/content-pack';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let stepId = $derived($denizenBuilder.currentStepId);
	let draft = $derived($denizenBuilder.draft);

	let theme = $derived(data.themes.find((t) => t.id === draft.themeId));
	let threat = $derived(data.threats.find((t) => t.id === draft.threatId));
	let templatesChosen = $derived(Boolean(theme && threat));
	let statWarnings = $derived(draftStatWarnings(draft, threat ?? null));

	// The step path is mode-dependent: pool-based threats visit a Pools step.
	let poolsMode = $derived(threat?.builderMode === 'pools');
	let steps = $derived(builderPath(poolsMode));
	let stepIndex = $derived(steps.findIndex((s) => s.id === stepId));

	// A mode switch can strand the persisted position on a step the new path
	// doesn't visit (e.g. 'pools' after reseeding to a standard threat) —
	// snap to Customize, the last step both paths share.
	$effect(() => {
		if (stepIndex === -1) denizenBuilder.goToStep('customize');
	});

	// Description-only templates stay reference material (capability from
	// data, never template ids); pool-based threats are fully supported.
	const usableInBuilder = (option: { builderMode?: string }) =>
		(option.builderMode ?? 'standard') !== 'unsupported';

	// A persisted draft can reference a template the builder no longer offers
	// (e.g. stored before capability metadata existed) — drop that selection.
	$effect(() => {
		if (theme && !usableInBuilder(theme)) {
			denizenBuilder.updateDraft((d) => ({ ...d, themeId: null }));
		}
		if (threat && !usableInBuilder(threat)) {
			denizenBuilder.updateDraft((d) => ({ ...d, threatId: null }));
		}
	});

	// Steps past Threat need both templates; re-seed stats when the pair changes.
	$effect(() => {
		if (stepIndex >= 3 && theme && threat && needsReseed(draft)) {
			denizenBuilder.updateDraft((d) => seedFromTemplates(d, theme, threat));
			announce(`Stat block seeded from ${theme.name} ${threat.name}.`);
		}
	});

	function go(next: number) {
		const clamped = Math.max(0, Math.min(next, steps.length - 1));
		denizenBuilder.goToStep(steps[clamped].id);
	}

	function stepAccessible(i: number): boolean {
		return i <= 2 || templatesChosen;
	}

	function confirmStartOver() {
		if (!confirm('Discard this denizen and start over?')) return;
		denizenBuilder.reset();
		announce('Denizen builder reset.');
	}

	// --- ability-list editing -------------------------------------------------
	// Lists are addressed by key so the same snippets edit the draft's own
	// lists ('notes') and a pool's lists ('pool:0:notes') interchangeably.

	type AbilityKind = 'notes' | 'lesserDooms' | 'greaterDooms';
	type AbilityListKey = AbilityKind | `pool:${number}:${AbilityKind}`;

	function parsePoolKey(key: AbilityListKey): { pool: number; kind: AbilityKind } | null {
		const match = /^pool:(\d+):(notes|lesserDooms|greaterDooms)$/.exec(key);
		return match ? { pool: Number(match[1]), kind: match[2] as AbilityKind } : null;
	}

	function listAt(key: AbilityListKey): DenizenAbility[] {
		const scoped = parsePoolKey(key);
		if (scoped) return draft.pools[scoped.pool]?.[scoped.kind] ?? [];
		return draft[key as AbilityKind];
	}

	function updateList(key: AbilityListKey, change: (list: DenizenAbility[]) => DenizenAbility[]) {
		const scoped = parsePoolKey(key);
		denizenBuilder.updateDraft((d) => {
			if (scoped) {
				return updatePool(d, scoped.pool, (p) => ({
					...p,
					[scoped.kind]: change(p[scoped.kind])
				}));
			}
			const kind = key as AbilityKind;
			return { ...d, [kind]: change(d[kind]) };
		});
	}

	function addAbility(key: AbilityListKey, ability: DenizenAbility) {
		updateList(key, (list) => [...list, ability]);
	}

	function removeAbility(key: AbilityListKey, index: number) {
		updateList(key, (list) => list.filter((_, i) => i !== index));
	}

	function hasAbility(key: AbilityListKey, name: string): boolean {
		return listAt(key).some((a) => a.name === name);
	}

	// Inline editing of an ability already on the draft — template-seeded notes
	// often need pinning down (e.g. *which* element an immunity covers).
	let editing = $state<{ key: AbilityListKey; index: number } | null>(null);
	let editName = $state('');
	let editText = $state('');

	function startEdit(key: AbilityListKey, index: number) {
		editing = { key, index };
		editName = listAt(key)[index].name;
		editText = listAt(key)[index].text;
	}

	function saveEdit() {
		if (!editing || !editName.trim() || !editText.trim()) return;
		const { key, index } = editing;
		const ability = { name: editName.trim(), text: editText.trim() };
		updateList(key, (list) => list.map((a, i) => (i === index ? ability : a)));
		editing = null;
	}

	let customName = $state('');
	let customText = $state('');

	function addCustom(key: AbilityListKey) {
		if (!customName.trim() || !customText.trim()) return;
		addAbility(key, { name: customName.trim(), text: customText.trim() });
		customName = '';
		customText = '';
	}

	// --- pool editing ---------------------------------------------------------

	function setPoolField(index: number, field: 'name' | 'health' | 'defense' | 'text', value: string) {
		denizenBuilder.updateDraft((d) => updatePool(d, index, (p) => ({ ...p, [field]: value })));
	}

	function handleAddPool() {
		denizenBuilder.updateDraft(addPool);
		announce(`Pool ${draft.pools.length} added.`);
	}

	function handleRemovePool(index: number) {
		const label = draft.pools[index]?.name.trim() || `Pool ${index + 1}`;
		editing = null; // indices shift — drop any in-flight pool ability edit
		denizenBuilder.updateDraft((d) => removePool(d, index));
		announce(`${label} removed.`);
	}

	function handleMovePool(index: number, direction: -1 | 1) {
		editing = null;
		denizenBuilder.updateDraft((d) => movePool(d, index, direction));
	}

	// Per-pool "add ability" form state, keyed by pool index.
	let poolCustom = $state<Record<number, { name: string; text: string }>>({});

	function poolCustomFor(index: number): { name: string; text: string } {
		return poolCustom[index] ?? { name: '', text: '' };
	}

	function addPoolCustom(index: number, kind: AbilityKind) {
		const { name, text } = poolCustomFor(index);
		if (!name.trim() || !text.trim()) return;
		addAbility(`pool:${index}:${kind}`, { name: name.trim(), text: text.trim() });
		poolCustom = { ...poolCustom, [index]: { name: '', text: '' } };
	}

	function setField(field: string, value: string) {
		denizenBuilder.updateDraft((d) => ({ ...d, [field]: value }));
	}

	function setAttribute(suit: 'swords' | 'pentacles' | 'cups' | 'wands', value: string) {
		denizenBuilder.updateDraft((d) => ({
			...d,
			attributes: { ...d.attributes, [suit]: value }
		}));
	}

	let preview = $derived(toDenizenDefinition(draft));
</script>

{#snippet templateDoomPicker(key: AbilityListKey, options: DenizenAbility[], guidance: string | undefined)}
	{#if guidance}<p class="guidance">The template says: <em>{guidance}</em>.</p>{/if}
	<ul class="options">
		{#each options as option (option.name)}
			<li>
				<label>
					<input
						type="checkbox"
						checked={hasAbility(key, option.name)}
						onchange={(e) => {
							if (e.currentTarget.checked) addAbility(key, option);
							else removeAbility(key, listAt(key).findIndex((a) => a.name === option.name));
						}}
					/>
					<span>
						<strong>{abilityLabel(option.name)}</strong>
						<!-- eslint-disable-next-line svelte/no-at-html-tags -- content is authored + escaped by renderMarkdown -->
						<span class="inline-md">{@html renderMarkdown(option.text)}</span>
					</span>
				</label>
			</li>
		{/each}
	</ul>
{/snippet}

{#snippet currentAbilities(key: AbilityListKey, emptyLabel: string)}
	{#if listAt(key).length === 0}
		<p class="empty">{emptyLabel}</p>
	{:else}
		<ul class="current">
			{#each listAt(key) as ability, i (ability.name + i)}
				<li>
					{#if editing !== null && editing.key === key && editing.index === i}
						<div class="edit-fields">
							<input type="text" bind:value={editName} aria-label="Ability name" />
							<textarea rows="3" bind:value={editText} aria-label="Ability text"></textarea>
							<div class="edit-actions">
								<button type="button" onclick={saveEdit}>Save</button>
								<button type="button" class="remove" onclick={() => (editing = null)}>Cancel</button>
							</div>
						</div>
					{:else}
						<span><strong>{abilityLabel(ability.name)}</strong> {ability.text}</span>
						<button type="button" class="edit" onclick={() => startEdit(key, i)}>Edit</button>
						<button type="button" class="remove" onclick={() => removeAbility(key, i)}>
							Remove
						</button>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
{/snippet}

<svelte:head><title>Denizen Builder — Guild Book</title></svelte:head>

<section class="builder">
	<h1>Denizen Builder</h1>
	<p class="lede">
		Mix a theme and a threat, exaggerate one aspect, and shake. <a href="/denizens"
			>Back to the bestiary</a
		>
	</p>

	<nav class="steps" aria-label="Denizen builder progress">
		<ol>
			{#each steps as s, i (s.id)}
				<li>
					{#if i > 0}<span class="sep">/</span>{/if}
					{#if stepAccessible(i)}
						<button
							type="button"
							class="steplink"
							class:active={i === stepIndex}
							aria-current={i === stepIndex ? 'step' : undefined}
							onclick={() => go(i)}
						>
							{s.label}
						</button>
					{:else}
						<span class="locked">{s.label}</span>
					{/if}
				</li>
			{/each}
		</ol>
		<button type="button" class="startover" onclick={confirmStartOver}>Start over</button>
	</nav>

	{#if stepId === 'concept'}
		<h2>Concept</h2>
		<p>
			Start with a classic mythological monster, then exaggerate <em>one</em> aspect. One new idea
			at a time keeps the creature coherent — and makes even a zombie feel fresh.
		</p>
		<label class="field">
			<span>Name</span>
			<input type="text" value={draft.name} oninput={(e) => setField('name', e.currentTarget.value)} placeholder="e.g. Locust Husk" />
		</label>
		<label class="field">
			<span>Classic monster it starts from</span>
			<input type="text" value={draft.concept} oninput={(e) => setField('concept', e.currentTarget.value)} placeholder="e.g. A zombie" />
		</label>
		<label class="field">
			<span>The one exaggerated aspect</span>
			<input type="text" value={draft.exaggeration} oninput={(e) => setField('exaggeration', e.currentTarget.value)} placeholder="e.g. it's animated by a swarm of locusts" />
		</label>
		<label class="field">
			<span>Description (optional — defaults to the two lines above)</span>
			<textarea rows="4" value={draft.flavor} oninput={(e) => setField('flavor', e.currentTarget.value)}></textarea>
		</label>
	{:else if stepId === 'theme'}
		<h2>Theme</h2>
		<p>Theme defines the creature's mythological context. How is it fantastic?</p>
		<div class="picker">
			{#each data.themes as option (option.id)}
				{#if usableInBuilder(option)}
					<label class="pick-card" class:selected={draft.themeId === option.id}>
						<input
							type="radio"
							name="theme"
							value={option.id}
							checked={draft.themeId === option.id}
							onchange={() => setField('themeId', option.id)}
						/>
						<span class="pick-name">{option.name}</span>
						<span class="pick-desc">{option.description.split('\n')[0]}</span>
						{#if option.likes?.length}<span class="pick-meta"><strong>Likes:</strong> {option.likes.join(', ')}</span>{/if}
						{#if option.hates?.length}<span class="pick-meta"><strong>Hates:</strong> {option.hates.join(', ')}</span>{/if}
					</label>
				{:else}
					<div class="pick-card unavailable">
						<span class="pick-name">{option.name}</span>
						<span class="pick-desc">Not available in the builder.</span>
						{#if option.builderNote}<span class="pick-meta">{option.builderNote}</span>{/if}
						<span class="pick-meta"><a href="/denizens">Read it in the reference →</a></span>
					</div>
				{/if}
			{/each}
		</div>
	{:else if stepId === 'threat'}
		<h2>Threat</h2>
		<p>Threat defines the creature's personality, tactics, and overall strength. How does it act?</p>
		<div class="picker">
			{#each data.threats as option (option.id)}
				{#if usableInBuilder(option)}
					<label class="pick-card" class:selected={draft.threatId === option.id}>
						<input
							type="radio"
							name="threat"
							value={option.id}
							checked={draft.threatId === option.id}
							onchange={() => setField('threatId', option.id)}
						/>
						<span class="pick-name">{option.name}</span>
						<span class="pick-desc">{option.description.split('\n')[0]}</span>
						{#if option.attributes}
							<span class="pick-meta">
								Swords {option.attributes.swords} | Pentacles {option.attributes.pentacles} | Cups {option.attributes.cups} | Wands {option.attributes.wands}
								{#if option.health !== undefined}&nbsp;· HD {option.health}/{option.defense}{/if}
							</span>
						{/if}
						{#if option.statNote}<span class="pick-meta"><em>{option.statNote}</em></span>{/if}
					</label>
				{:else}
					<div class="pick-card unavailable">
						<span class="pick-name">{option.name}</span>
						<span class="pick-desc">Not available in the builder.</span>
						{#if option.builderNote}<span class="pick-meta">{option.builderNote}</span>{/if}
						<span class="pick-meta"><a href="/denizens">Read it in the reference →</a></span>
					</div>
				{/if}
			{/each}
		</div>
	{:else if !templatesChosen}
		<p class="empty">Choose a theme and a threat first.</p>
	{:else if stepId === 'customize'}
		<h2>Customize</h2>
		<p>
			The stat block below was seeded from <strong>{theme?.name} {threat?.name}</strong>. Change
			any detail to fit your concept — the book explicitly blesses it.
		</p>
		<div class="attr-grid">
			<label class="field"><span>Swords</span><input type="text" value={draft.attributes.swords} oninput={(e) => setAttribute('swords', e.currentTarget.value)} /></label>
			<label class="field"><span>Pentacles</span><input type="text" value={draft.attributes.pentacles} oninput={(e) => setAttribute('pentacles', e.currentTarget.value)} /></label>
			<label class="field"><span>Cups</span><input type="text" value={draft.attributes.cups} oninput={(e) => setAttribute('cups', e.currentTarget.value)} /></label>
			<label class="field"><span>Wands</span><input type="text" value={draft.attributes.wands} oninput={(e) => setAttribute('wands', e.currentTarget.value)} /></label>
			{#if !poolsMode}
				<label class="field"><span>Health</span><input type="text" value={draft.health} oninput={(e) => setField('health', e.currentTarget.value)} /></label>
				<label class="field"><span>Defense</span><input type="text" value={draft.defense} oninput={(e) => setField('defense', e.currentTarget.value)} /></label>
			{/if}
		</div>
		{#if poolsMode}
			<p class="guidance">
				This creature's Health and Defense live in named pools — you'll build them on the
				<strong>Pools</strong> step.
			</p>
			{#if threat?.statNote}
				<!-- Build-time instruction from the template, not stat-block content. -->
				<p class="guidance"><em>{threat.statNote}</em></p>
			{/if}
		{/if}
		{#each statWarnings as warning (warning)}
			<p class="warning" role="alert">{warning}</p>
		{/each}
		{#if draft.statNote || threat?.statNote}
			<label class="field">
				<span>Stat note (explains irregular stats — from the {threat?.name} template)</span>
				<input type="text" value={draft.statNote} oninput={(e) => setField('statNote', e.currentTarget.value)} />
			</label>
		{/if}
		{#if poolsMode}
			<label class="field">
				<span>Special rules (fight-changing rules that precede the pools)</span>
				<textarea rows="3" value={draft.specialRules} oninput={(e) => setField('specialRules', e.currentTarget.value)} placeholder="e.g. The lord regrows a defeated pool at dawn."></textarea>
			</label>
		{/if}
		<label class="field">
			<span>Likes (comma-separated)</span>
			<input type="text" value={draft.likes} oninput={(e) => setField('likes', e.currentTarget.value)} />
		</label>
		<label class="field">
			<span>Hates (comma-separated)</span>
			<input type="text" value={draft.hates} oninput={(e) => setField('hates', e.currentTarget.value)} />
		</label>

		<h3>Notes</h3>
		<p class="guidance">Standing abilities that don't cost a card — seeded from both templates.</p>
		{#if threat?.notesOptional}
			<p class="guidance optional-note">
				The {threat.name} notes below are <strong>optional</strong> — a menu, not a package.
				Remove the ones that don't fit, and use Edit to pin down specifics (e.g. which damage
				source an Invulnerable ignores).
			</p>
		{/if}
		{@render currentAbilities('notes', 'No notes.')}
		<div class="add-custom">
			<input type="text" bind:value={customName} placeholder="Note name" />
			<textarea rows="2" bind:value={customText} placeholder="What the GM needs to remember"></textarea>
			<button type="button" onclick={() => addCustom('notes')}>Add note</button>
		</div>
	{:else if stepId === 'pools'}
		<h2>Pools</h2>
		<p>
			Each pool is a named part of the creature with its own Health and Defense, special rules,
			and dooms. Each can be attacked separately — as long as a pool stands, the creature keeps
			its abilities. Make it clear what each pool is and what defeating it means.
		</p>
		{#each statWarnings as warning (warning)}
			<p class="warning" role="alert">{warning}</p>
		{/each}
		{#each draft.pools as pool, pi (pi)}
			<fieldset class="pool-editor">
				<legend>{pool.name.trim() || `Pool ${pi + 1}`}</legend>
				<div class="pool-head">
					<label class="field pool-name-field">
						<span>Pool name</span>
						<input type="text" value={pool.name} oninput={(e) => setPoolField(pi, 'name', e.currentTarget.value)} placeholder="e.g. The Crown" aria-label={`Pool ${pi + 1} name`} />
					</label>
					<label class="field">
						<span>Health</span>
						<input type="text" value={pool.health} oninput={(e) => setPoolField(pi, 'health', e.currentTarget.value)} aria-label={`Pool ${pi + 1} Health`} />
					</label>
					<label class="field">
						<span>Defense</span>
						<input type="text" value={pool.defense} oninput={(e) => setPoolField(pi, 'defense', e.currentTarget.value)} aria-label={`Pool ${pi + 1} Defense`} />
					</label>
				</div>
				<label class="field">
					<span>What defeating this pool means</span>
					<textarea rows="2" value={pool.text} oninput={(e) => setPoolField(pi, 'text', e.currentTarget.value)} placeholder="e.g. Shattering the crown breaks its dominion over the level." aria-label={`Pool ${pi + 1} description`}></textarea>
				</label>

				<h4>Notes</h4>
				{@render currentAbilities(`pool:${pi}:notes`, 'No notes on this pool.')}
				<h4>Lesser dooms</h4>
				{@render currentAbilities(`pool:${pi}:lesserDooms`, 'No lesser dooms on this pool.')}
				<h4>Greater dooms</h4>
				{@render currentAbilities(`pool:${pi}:greaterDooms`, 'No greater dooms on this pool.')}
				<div class="add-custom">
					<input type="text" value={poolCustomFor(pi).name} oninput={(e) => (poolCustom = { ...poolCustom, [pi]: { ...poolCustomFor(pi), name: e.currentTarget.value } })} placeholder="Ability name" aria-label={`Pool ${pi + 1} new ability name`} />
					<textarea rows="2" value={poolCustomFor(pi).text} oninput={(e) => (poolCustom = { ...poolCustom, [pi]: { ...poolCustomFor(pi), text: e.currentTarget.value } })} placeholder="What it does" aria-label={`Pool ${pi + 1} new ability text`}></textarea>
					<div class="pool-add-actions">
						<button type="button" onclick={() => addPoolCustom(pi, 'notes')}>Add note</button>
						<button type="button" onclick={() => addPoolCustom(pi, 'lesserDooms')}>Add lesser doom</button>
						<button type="button" onclick={() => addPoolCustom(pi, 'greaterDooms')}>Add greater doom</button>
					</div>
				</div>
				<div class="pool-actions">
					{#if draft.pools.length > 1}
						<button type="button" onclick={() => handleMovePool(pi, -1)} disabled={pi === 0} aria-label={`Move pool ${pi + 1} up`}>↑ Move up</button>
						<button type="button" onclick={() => handleMovePool(pi, 1)} disabled={pi === draft.pools.length - 1} aria-label={`Move pool ${pi + 1} down`}>↓ Move down</button>
					{/if}
					<button type="button" class="remove" onclick={() => handleRemovePool(pi)}>Remove pool</button>
				</div>
			</fieldset>
		{/each}
		<button type="button" class="add-pool" onclick={handleAddPool}>+ Add pool</button>
	{:else if stepId === 'dooms'}
		<h2>Dooms</h2>
		<p>
			Pick from the template lists, then invent one or two dooms for your exaggerated aspect
			{#if draft.exaggeration}(<em>{draft.exaggeration}</em>){/if} — that's what makes it fresh.
		</p>
		{#if poolsMode}
			<p class="guidance">
				Most of a pool-based creature's dooms live on its pools — add those on the
				<strong>Pools</strong> step. Dooms added here apply no matter which pools still stand.
			</p>
		{/if}

		<h3>Lesser dooms <span class="from">from {theme?.name}</span></h3>
		{#if theme?.lesserDooms?.length}
			{@render templateDoomPicker('lesserDooms', theme.lesserDooms, theme.chooseLesserDooms)}
		{:else}
			<p class="empty">The {theme?.name} theme has no default lesser dooms.</p>
		{/if}

		<h3>Greater dooms <span class="from">from {threat?.name}</span></h3>
		{#if threat?.greaterDooms?.length}
			{@render templateDoomPicker('greaterDooms', threat.greaterDooms, threat.chooseGreaterDooms)}
		{:else}
			<p class="empty">The {threat?.name} threat has no default greater dooms.</p>
		{/if}

		<h3>Your dooms</h3>
		<h4>Lesser</h4>
		{@render currentAbilities('lesserDooms', 'No lesser dooms yet.')}
		<h4>Greater</h4>
		{@render currentAbilities('greaterDooms', 'No greater dooms yet.')}
		<div class="add-custom">
			<input type="text" bind:value={customName} placeholder="Doom name" />
			<textarea rows="2" bind:value={customText} placeholder="What it does"></textarea>
			<button type="button" onclick={() => addCustom('lesserDooms')}>Add as lesser doom</button>
			<button type="button" onclick={() => addCustom('greaterDooms')}>Add as greater doom</button>
		</div>
	{:else if stepId === 'review'}
		<h2>Review</h2>
		{#each statWarnings as warning (warning)}
			<p class="warning" role="alert">{warning}</p>
		{/each}
		<DenizenExportButtons denizen={preview} themeName={theme?.name ?? ''} threatName={threat?.name ?? ''} />
		<div class="preview">
			<DenizenStatBlock denizen={preview} themeName={theme?.name ?? ''} threatName={threat?.name ?? ''} />
		</div>
	{/if}

	<div class="nav-buttons">
		{#if stepIndex > 0}
			<button type="button" onclick={() => go(stepIndex - 1)}>← Back</button>
		{/if}
		{#if stepIndex < steps.length - 1}
			<button
				type="button"
				class="primary"
				disabled={stepIndex >= 2 && !templatesChosen}
				onclick={() => go(stepIndex + 1)}
			>
				Next →
			</button>
		{/if}
	</div>
</section>

<style>
	.builder {
		max-width: 46rem;
		margin: 0 auto;
	}
	.lede {
		color: var(--ink-soft);
		margin-top: -0.25rem;
	}
	.steps {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin: 1.25rem 0 1.75rem;
	}
	.steps ol {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem;
		list-style: none;
		margin: 0;
		padding: 0;
		font-family: var(--font-subhead);
		font-size: 0.9rem;
	}
	.steps li {
		display: flex;
		align-items: center;
	}
	.sep {
		margin: 0 0.4rem;
		color: var(--ink-soft);
	}
	.steplink {
		border: none;
		background: none;
		padding: 0;
		font: inherit;
		color: var(--ink-soft);
		cursor: pointer;
	}
	.steplink.active {
		color: var(--accent);
		font-weight: 600;
	}
	.locked {
		opacity: 0.5;
	}
	.startover {
		flex-shrink: 0;
		border: none;
		background: none;
		color: var(--ink-soft);
		font-size: 0.75rem;
		cursor: pointer;
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.field {
		display: block;
		margin: 0.75rem 0;
	}
	.field span {
		display: block;
		font-family: var(--font-subhead);
		font-size: 0.85rem;
		margin-bottom: 0.25rem;
		color: var(--ink-soft);
	}
	.field input,
	.field textarea {
		width: 100%;
		padding: 0.5rem 0.7rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 4px;
		background: var(--parchment);
		font: inherit;
	}
	.picker {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
		gap: 0.75rem;
	}
	.pick-card {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		padding: 0.75rem 0.9rem;
		border: 1px solid color-mix(in oklab, var(--ink) 18%, transparent);
		border-radius: 6px;
		cursor: pointer;
	}
	.pick-card.selected {
		border-color: var(--accent);
		background: color-mix(in oklab, var(--accent) 7%, transparent);
	}
	.pick-card.unavailable {
		cursor: default;
		opacity: 0.75;
		border-style: dashed;
	}
	.warning {
		font-size: 0.9rem;
		color: var(--accent);
		border-left: 3px solid var(--accent);
		padding-left: 0.6rem;
	}
	.pick-card input {
		position: absolute;
		opacity: 0;
	}
	.pick-name {
		font-family: var(--font-subhead);
		font-size: 1.05rem;
	}
	.pick-desc {
		font-size: 0.85rem;
		color: var(--ink-soft);
	}
	.pick-meta {
		font-size: 0.8rem;
		color: var(--ink-soft);
	}
	.attr-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(7rem, 1fr));
		gap: 0.5rem 0.75rem;
	}
	.attr-grid .field {
		margin: 0.25rem 0;
	}
	.options,
	.current {
		list-style: none;
		margin: 0.5rem 0 1rem;
		padding: 0;
	}
	.options li,
	.current li {
		display: flex;
		gap: 0.5rem;
		align-items: baseline;
		padding: 0.4rem 0;
		border-bottom: 1px solid color-mix(in oklab, var(--ink) 10%, transparent);
	}
	.options label {
		display: flex;
		gap: 0.5rem;
		align-items: baseline;
		cursor: pointer;
	}
	.current li span:first-child {
		flex: 1;
	}
	.inline-md :global(p) {
		display: inline;
	}
	.inline-md :global(ul) {
		margin: 0.35rem 0 0;
	}
	.edit,
	.remove {
		border: none;
		background: none;
		color: var(--accent);
		font-size: 0.8rem;
		cursor: pointer;
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.edit {
		color: var(--ink-soft);
	}
	.edit-fields {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.25rem 0;
	}
	.edit-fields input,
	.edit-fields textarea {
		width: 100%;
		padding: 0.45rem 0.6rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 4px;
		background: var(--parchment);
		font: inherit;
	}
	.edit-actions {
		display: flex;
		gap: 0.75rem;
		align-items: baseline;
	}
	.edit-actions button {
		font: inherit;
		font-family: var(--font-subhead);
		font-size: 0.85rem;
		padding: 0.3rem 0.8rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 4px;
		background: none;
		color: var(--ink);
		cursor: pointer;
	}
	.edit-actions .remove {
		border: none;
		padding: 0.3rem 0;
	}
	.add-custom {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin: 0.75rem 0 1rem;
		padding: 0.75rem;
		border: 1px dashed color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 6px;
	}
	.add-custom input,
	.add-custom textarea {
		padding: 0.45rem 0.6rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 4px;
		background: var(--parchment);
		font: inherit;
	}
	.add-custom button {
		align-self: flex-start;
	}
	.guidance {
		font-size: 0.9rem;
		color: var(--ink-soft);
	}
	.pool-editor {
		margin: 1rem 0;
		padding: 0.9rem 1rem;
		border: 1px solid color-mix(in oklab, var(--ink) 18%, transparent);
		border-radius: 6px;
	}
	.pool-editor legend {
		font-family: var(--font-subhead);
		font-size: 1.05rem;
		padding: 0 0.4rem;
	}
	.pool-head {
		display: grid;
		grid-template-columns: 2fr 1fr 1fr;
		gap: 0.5rem 0.75rem;
	}
	.pool-head .field {
		margin: 0.25rem 0;
	}
	.pool-add-actions,
	.pool-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		align-items: baseline;
	}
	.pool-actions {
		margin-top: 0.75rem;
	}
	.pool-actions button,
	.pool-add-actions button,
	.add-pool {
		font: inherit;
		font-family: var(--font-subhead);
		font-size: 0.85rem;
		padding: 0.3rem 0.8rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 4px;
		background: none;
		color: var(--ink);
		cursor: pointer;
	}
	.pool-actions button:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.pool-actions .remove {
		border: none;
		color: var(--accent);
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.add-pool {
		margin: 0.25rem 0 0.5rem;
	}
	.from {
		font-size: 0.8rem;
		font-weight: normal;
		color: var(--ink-soft);
	}
	.empty {
		color: var(--ink-soft);
	}
	.preview {
		padding: 1rem 1.25rem;
		border: 1px solid color-mix(in oklab, var(--ink) 18%, transparent);
		border-radius: 6px;
	}
	.nav-buttons {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		margin-top: 2rem;
	}
	.nav-buttons button {
		font: inherit;
		font-family: var(--font-subhead);
		padding: 0.5rem 1.1rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 4px;
		background: none;
		color: var(--ink);
		cursor: pointer;
	}
	.nav-buttons .primary {
		margin-left: auto;
		background: var(--accent);
		border-color: var(--accent);
		color: var(--parchment);
	}
	.nav-buttons .primary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	h3 {
		margin: 1.5rem 0 0.25rem;
	}
	h4 {
		margin: 0.9rem 0 0;
		font-family: var(--font-subhead);
		font-size: 0.95rem;
		color: var(--ink-soft);
	}
</style>
