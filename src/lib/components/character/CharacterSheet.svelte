<script lang="ts">
	import type { CharacterView } from '$lib/types/character-view';

	let { view }: { view: CharacterView } = $props();
</script>

<article class="sheet">
	<header>
		<h1>{view.name}</h1>
		<p class="sub">
			{#if view.pronouns}<span>{view.pronouns}</span>{/if}
			{#if view.kin}<span>{view.kin}{view.kith ? ` (${view.kith})` : ''}</span>{/if}
			{#if view.path}<span>{view.path}</span>{/if}
		</p>
	</header>

	<section class="attributes">
		{#each view.attributes as attr (attr.id)}
			<div class="attr">
				<span class="attr-value">{attr.value}</span>
				<span class="attr-name">{attr.name}</span>
			</div>
		{/each}
	</section>

	{#if view.appearance}
		<section><h2>Appearance</h2><p>{view.appearance}</p></section>
	{/if}

	{#if view.quest}
		<section><h2>Quest</h2><p>{view.quest}</p></section>
	{/if}

	{#if view.motifs.length}
		<section>
			<h2>Motifs</h2>
			<ul class="inline">{#each view.motifs as m}<li>{m}</li>{/each}</ul>
		</section>
	{/if}

	{#if view.talents.length}
		<section>
			<h2>Talents</h2>
			<ul>
				{#each view.talents as t}
					<li>{t.name} <span class="tag">{t.state}</span></li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if view.equipment.length}
		<section>
			<h2>Gear</h2>
			<ul>{#each view.equipment as e}<li>{e.name} <span class="tag">{e.tier}</span></li>{/each}</ul>
		</section>
	{/if}

	<section class="meta">
		<span>Resolve {view.resolve.current}/{view.resolve.max}</span>
		{#if view.languages.length}<span>Languages: {view.languages.join(', ')}</span>{/if}
		{#if view.conditions.length}<span>Conditions: {view.conditions.join(', ')}</span>{/if}
	</section>
</article>

<style>
	.sheet {
		border: 1px solid color-mix(in oklab, var(--ink) 20%, transparent);
		border-radius: 4px;
		padding: 1.5rem;
		background: color-mix(in oklab, var(--parchment) 94%, white);
	}
	header h1 {
		margin: 0;
	}
	.sub {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		margin: 0.25rem 0 0;
		color: var(--ink-soft);
		font-family: var(--font-subhead);
	}
	.attributes {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 0.75rem;
		margin: 1.25rem 0;
	}
	.attr {
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 0.75rem;
		border: 1px solid color-mix(in oklab, var(--ink) 18%, transparent);
		border-radius: 4px;
	}
	.attr-value {
		font-family: var(--font-display);
		font-size: 2rem;
		line-height: 1;
	}
	.attr-name {
		font-size: 0.8rem;
		color: var(--ink-soft);
	}
	section {
		margin: 1rem 0;
	}
	h2 {
		font-size: 1rem;
		margin: 0 0 0.35rem;
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
		padding: 0.15rem 0.5rem;
		border: 1px solid color-mix(in oklab, var(--ink) 18%, transparent);
		border-radius: 999px;
		font-size: 0.85rem;
	}
	.tag {
		font-size: 0.7rem;
		color: var(--ink-soft);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		gap: 1rem;
		font-size: 0.85rem;
		color: var(--ink-soft);
	}
</style>
