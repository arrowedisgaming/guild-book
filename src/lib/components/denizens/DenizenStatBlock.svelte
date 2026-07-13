<script lang="ts">
	import { renderMarkdown } from '$lib/utils/markdown';
	import { abilityLabel } from '$lib/utils/ability-label';
	import type {
		DenizenDefinition,
		DenizenAbility,
		DenizenStatValue
	} from '$lib/types/content-pack';

	let {
		denizen,
		themeName,
		threatName,
		headingLevel = 2
	}: {
		denizen: DenizenDefinition;
		themeName: string;
		threatName: string;
		headingLevel?: number;
	} = $props();

	const hd = (health: DenizenStatValue, defense: DenizenStatValue) => `${health}/${defense}`;
</script>

{#snippet abilities(title: string, list: DenizenAbility[] | undefined)}
	{#if list?.length}
		<section class="abilities">
			<h4>{title}</h4>
			<ul>
				{#each list as ability (ability.name)}
					<li>
						<strong>{abilityLabel(ability.name)}</strong>
						<!-- eslint-disable-next-line svelte/no-at-html-tags -- content is authored + escaped by renderMarkdown -->
						<span class="ability-text">{@html renderMarkdown(ability.text)}</span>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
{/snippet}

<article class="statblock">
	<svelte:element this={`h${headingLevel}`} class="name">{denizen.name}</svelte:element>
	<p class="type">{themeName} {threatName}</p>

	<div class="flavor">
		<!-- eslint-disable-next-line svelte/no-at-html-tags -- content is authored + escaped by renderMarkdown -->
		{@html renderMarkdown(denizen.flavor)}
	</div>

	<div class="stats">
		<p>
			<strong>Attributes:</strong>
			Swords {denizen.attributes.swords} | Pentacles {denizen.attributes.pentacles} | Cups {denizen
				.attributes.cups} | Wands {denizen.attributes.wands}
		</p>
		{#if denizen.health !== undefined && denizen.defense !== undefined}
			<p><strong>Health/Defense:</strong> {hd(denizen.health, denizen.defense)}</p>
		{/if}
		{#if denizen.statNote}
			<p class="stat-note">{denizen.statNote}</p>
		{/if}
		{#if denizen.likes?.length}
			<p><strong>Likes:</strong> {denizen.likes.join(', ')}</p>
		{/if}
		{#if denizen.hates?.length}
			<p><strong>Hates:</strong> {denizen.hates.join(', ')}</p>
		{/if}
	</div>

	{#if denizen.specialRules}
		<section class="abilities">
			<h4>Special rules</h4>
			<!-- eslint-disable-next-line svelte/no-at-html-tags -- content is authored + escaped by renderMarkdown -->
			{@html renderMarkdown(denizen.specialRules)}
		</section>
	{/if}

	{@render abilities('Notes', denizen.notes)}
	{@render abilities('Lesser dooms', denizen.lesserDooms)}
	{@render abilities('Greater dooms', denizen.greaterDooms)}

	{#each denizen.pools ?? [] as pool (pool.id)}
		<section class="pool">
			<h4 class="pool-name">{pool.name} — Health/Defense: {hd(pool.health, pool.defense)}</h4>
			{#if pool.text}
				<!-- eslint-disable-next-line svelte/no-at-html-tags -- content is authored + escaped by renderMarkdown -->
				{@html renderMarkdown(pool.text)}
			{/if}
			{@render abilities('Notes', pool.notes)}
			{@render abilities('Lesser dooms', pool.lesserDooms)}
			{@render abilities('Greater dooms', pool.greaterDooms)}
		</section>
	{/each}

	{#each denizen.sidebars ?? [] as sidebar (sidebar.title)}
		<aside class="sidebar">
			<h4>{sidebar.title}</h4>
			<!-- eslint-disable-next-line svelte/no-at-html-tags -- content is authored + escaped by renderMarkdown -->
			{@html renderMarkdown(sidebar.body)}
		</aside>
	{/each}
</article>

<style>
	.statblock {
		max-width: 46rem;
	}
	.name {
		margin: 0;
	}
	.type {
		margin: 0.15rem 0 1rem;
		font-style: italic;
		font-family: var(--font-subhead);
		color: var(--ink-soft);
	}
	.flavor {
		font-style: italic;
		color: var(--ink-soft);
	}
	.flavor :global(p) {
		margin: 0 0 0.6rem;
	}
	.stats {
		margin: 1rem 0;
		padding: 0.75rem 1rem;
		border-block: 2px solid color-mix(in oklab, var(--accent) 40%, transparent);
	}
	.stats p {
		margin: 0.25rem 0;
	}
	.stat-note {
		font-style: italic;
		color: var(--ink-soft);
	}
	.abilities h4,
	.pool-name,
	.sidebar h4 {
		font-family: var(--font-subhead);
		font-size: 1.05rem;
		margin: 1.1rem 0 0.35rem;
		border-bottom: 1px solid color-mix(in oklab, var(--ink) 15%, transparent);
		padding-bottom: 0.15rem;
	}
	.abilities ul {
		margin: 0;
		padding-left: 1.1rem;
	}
	.abilities li {
		margin-bottom: 0.5rem;
	}
	.ability-text :global(p) {
		display: inline;
	}
	.ability-text :global(p + ul),
	.ability-text :global(ul) {
		display: block;
		margin: 0.35rem 0 0;
	}
	.pool {
		margin-top: 1.25rem;
	}
	.pool :global(p) {
		margin: 0.35rem 0;
	}
	.sidebar {
		margin-top: 1.25rem;
		padding: 0.75rem 1rem;
		background: color-mix(in oklab, var(--accent) 7%, transparent);
		border-left: 3px solid color-mix(in oklab, var(--accent) 45%, transparent);
	}
	.sidebar :global(p) {
		margin: 0.35rem 0;
	}
</style>
