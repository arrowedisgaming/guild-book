<script lang="ts">
	import RulesSearch from '$lib/components/rules/RulesSearch.svelte';
	import { renderMarkdown } from '$lib/utils/markdown';
	import { abilityLabel } from '$lib/utils/ability-label';
	import type { DenizenAbility } from '$lib/types/content-pack';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let query = $state('');
	let themeFilter = $state<string | null>(null);
	let threatFilter = $state<string | null>(null);

	const themeName = (id: string) => data.themes.find((t) => t.id === id)?.name ?? id;
	const threatName = (id: string) => data.threats.find((t) => t.id === id)?.name ?? id;

	let filtered = $derived.by(() => {
		const q = query.trim().toLowerCase();
		return data.bestiary.filter((d) => {
			if (themeFilter && d.theme !== themeFilter) return false;
			if (threatFilter && d.threat !== threatFilter) return false;
			if (q && !d.name.toLowerCase().includes(q)) return false;
			return true;
		});
	});
</script>

{#snippet abilityList(title: string, list: DenizenAbility[] | undefined, pick: string | undefined)}
	{#if list?.length}
		<h4>{title}{#if pick}&nbsp;<em class="pick">({pick})</em>{/if}</h4>
		<ul>
			{#each list as ability (ability.name)}
				<li>
					<strong>{abilityLabel(ability.name)}</strong>
					<!-- eslint-disable-next-line svelte/no-at-html-tags -- content is authored + escaped by renderMarkdown -->
					<span class="inline-md">{@html renderMarkdown(ability.text)}</span>
				</li>
			{/each}
		</ul>
	{/if}
{/snippet}

<svelte:head><title>Dungeon Denizens — Guild Book</title></svelte:head>

<section class="denizens">
	<h1>Dungeon Denizens</h1>
	<p class="lede">
		The bestiary of the Underworld, with the theme &amp; threat templates for mixing your own
		creatures. <a href="/denizens/build">Build a denizen →</a>
	</p>

	<RulesSearch bind:value={query} placeholder="Search denizens…" />

	<div class="filters">
		<div class="chip-row" role="group" aria-label="Filter by theme">
			{#each data.themes as theme (theme.id)}
				<button
					type="button"
					class="chip"
					class:active={themeFilter === theme.id}
					aria-pressed={themeFilter === theme.id}
					onclick={() => (themeFilter = themeFilter === theme.id ? null : theme.id)}
				>
					{theme.name}
				</button>
			{/each}
		</div>
		<div class="chip-row" role="group" aria-label="Filter by threat">
			{#each data.threats as threat (threat.id)}
				<button
					type="button"
					class="chip threat"
					class:active={threatFilter === threat.id}
					aria-pressed={threatFilter === threat.id}
					onclick={() => (threatFilter = threatFilter === threat.id ? null : threat.id)}
				>
					{threat.name}
				</button>
			{/each}
		</div>
	</div>

	{#if filtered.length === 0}
		<p class="empty">No denizens match.</p>
	{:else}
		<ul class="grid">
			{#each filtered as denizen (denizen.id)}
				<li>
					<a class="card" href={`/denizens/${denizen.id}`}>
						<span class="card-name">{denizen.name}</span>
						<span class="card-type">{themeName(denizen.theme)} {threatName(denizen.threat)}</span>
						<span class="card-hd">
							{#if denizen.pools?.length}
								HD: {denizen.pools.map((p) => `${p.name} ${p.health}/${p.defense}`).join(' · ')}
							{:else}
								HD {denizen.health}/{denizen.defense}
							{/if}
						</span>
					</a>
				</li>
			{/each}
		</ul>
	{/if}

	<section class="templates">
		<h2>Templates</h2>
		<p>
			Every creature is a combination of a <strong>theme</strong> (its mythological context) and a
			<strong>threat</strong> (its personality, tactics, and strength). Combine one of each, then
			exaggerate one aspect.
		</p>

		<h3>Themes</h3>
		{#each data.themes as theme (theme.id)}
			<details class="template">
				<summary>{theme.name}</summary>
				<div class="template-body">
					<!-- eslint-disable-next-line svelte/no-at-html-tags -- content is authored + escaped by renderMarkdown -->
					{@html renderMarkdown(theme.description)}
					{#if theme.likes?.length}<p><strong>Likes:</strong> {theme.likes.join(', ')}</p>{/if}
					{#if theme.hates?.length}<p><strong>Hates:</strong> {theme.hates.join(', ')}</p>{/if}
					{@render abilityList('Notes', theme.notes, undefined)}
					{@render abilityList('Lesser dooms', theme.lesserDooms, theme.chooseLesserDooms)}
				</div>
			</details>
		{/each}

		<h3>Threats</h3>
		{#each data.threats as threat (threat.id)}
			<details class="template">
				<summary>{threat.name}</summary>
				<div class="template-body">
					<!-- eslint-disable-next-line svelte/no-at-html-tags -- content is authored + escaped by renderMarkdown -->
					{@html renderMarkdown(threat.description)}
					{#if threat.attributes}
						<p>
							<strong>Attributes:</strong>
							Swords {threat.attributes.swords} | Pentacles {threat.attributes.pentacles} | Cups {threat
								.attributes.cups} | Wands {threat.attributes.wands}
						</p>
					{/if}
					{#if threat.health !== undefined && threat.defense !== undefined}
						<p><strong>HD</strong> {threat.health}/{threat.defense}</p>
					{/if}
					{#if threat.statNote}<p><em>{threat.statNote}</em></p>{/if}
					{@render abilityList(
						threat.notesOptional ? 'Notes (Optional)' : 'Notes',
						threat.notes,
						undefined
					)}
					{@render abilityList('Greater dooms', threat.greaterDooms, threat.chooseGreaterDooms)}
				</div>
			</details>
		{/each}
	</section>
</section>

<style>
	.denizens {
		max-width: 46rem;
		margin: 0 auto;
	}
	.lede {
		color: var(--ink-soft);
		margin-top: -0.25rem;
	}
	.filters {
		margin: 1rem 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.chip-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}
	.chip {
		font: inherit;
		font-family: var(--font-subhead);
		font-size: 0.85rem;
		padding: 0.15rem 0.7rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 999px;
		background: none;
		color: var(--ink-soft);
		cursor: pointer;
	}
	.chip.active {
		background: color-mix(in oklab, var(--accent) 18%, transparent);
		border-color: var(--accent);
		color: var(--ink);
	}
	.grid {
		list-style: none;
		margin: 1.25rem 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
		gap: 0.75rem;
	}
	.card {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		height: 100%;
		padding: 0.75rem 0.9rem;
		border: 1px solid color-mix(in oklab, var(--ink) 18%, transparent);
		border-radius: 6px;
		text-decoration: none;
		color: var(--ink);
	}
	.card:hover {
		border-color: var(--accent);
	}
	.card-name {
		font-family: var(--font-subhead);
		font-size: 1.05rem;
	}
	.card-type {
		font-style: italic;
		font-size: 0.85rem;
		color: var(--ink-soft);
	}
	.card-hd {
		font-size: 0.8rem;
		color: var(--ink-soft);
	}
	.empty {
		color: var(--ink-soft);
		margin-top: 1.25rem;
	}
	.templates {
		margin-top: 2.5rem;
	}
	.templates h2 {
		font-size: 1.35rem;
		border-bottom: 2px solid color-mix(in oklab, var(--accent) 40%, transparent);
		padding-bottom: 0.25rem;
	}
	.template {
		border-bottom: 1px solid color-mix(in oklab, var(--ink) 12%, transparent);
		padding: 0.5rem 0;
	}
	.template summary {
		font-family: var(--font-subhead);
		font-size: 1.05rem;
		cursor: pointer;
	}
	.template-body {
		padding: 0.5rem 0 0.25rem 1rem;
	}
	.template-body :global(p) {
		margin: 0 0 0.6rem;
	}
	.template-body ul {
		margin: 0 0 0.6rem;
		padding-left: 1.1rem;
	}
	.template-body li {
		margin-bottom: 0.4rem;
	}
	.inline-md :global(p) {
		display: inline;
	}
	.inline-md :global(ul) {
		margin: 0.35rem 0 0;
	}
	.pick {
		font-size: 0.85em;
		color: var(--ink-soft);
	}
</style>
