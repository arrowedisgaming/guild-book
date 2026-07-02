<script lang="ts">
	import type { CharacterView } from '$lib/types/character-view';

	let { view }: { view: CharacterView } = $props();

	const locations = [
		{ id: 'hand', label: 'In hand' },
		{ id: 'worn', label: 'Worn' },
		{ id: 'belt', label: 'Belt' },
		{ id: 'pack', label: 'Backpack' }
	];
	const gearAt = (loc: string) => view.equipment.filter((e) => e.location === loc);
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

	{#if view.conditions.length || view.afflictions.length}
		<section class="statusline">
			{#each view.conditions as c (c.id)}
				<span class="badge cond" title={c.description}>{c.name}</span>
			{/each}
			{#each view.afflictions as a}
				<span class="badge aff" title={a.effect}>{a.name} — stage {a.stage}/{a.stageCount}</span>
			{/each}
		</section>
	{/if}

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
					<li class:wounded={t.wounded}>
						{t.name}
						<span class="tag">{t.state}{t.state === 'in-training' && t.xp > 0 ? ` · ${t.xp}/7 xp` : ''}</span>
						{#if t.wounded}<span class="tag hurt">wounded</span>{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if view.bonds.length}
		<section>
			<h2>Bonds</h2>
			<ul>
				{#each view.bonds as b}
					<li>
						<span class="charge" class:on={b.charged}>{b.charged ? '●' : '○'}</span>
						<strong>{b.targetName}</strong>{b.text ? ` — ${b.text}` : ''}
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if view.equipment.length}
		<section>
			<h2>
				Gear
				<span class="load">
					Hands {view.load.hands.used}/{view.load.hands.capacity} · Belt
					{view.load.belt.used}/{view.load.belt.capacity} · Pack
					{view.load.pack.used}/{view.load.pack.capacity}
				</span>
			</h2>
			{#each locations as loc (loc.id)}
				{@const gear = gearAt(loc.id)}
				{#if gear.length}
					<h3>{loc.label}</h3>
					<ul>
						{#each gear as e}
							<li class:destroyed={e.destroyed}>
								{e.name}{e.quantity > 1 ? ` ×${e.quantity}` : ''}
								<span class="tag">{e.tier}</span>
								{#if e.durability}
									<span class="tag">{e.notchesTaken}/{e.durability} notches</span>
								{/if}
								{#if e.destroyed}<span class="tag hurt">destroyed</span>{/if}
							</li>
						{/each}
					</ul>
				{/if}
			{/each}
		</section>
	{/if}

	<section class="meta">
		<span>Resolve {view.resolve.current}/{view.resolve.max}</span>
		<span>Lore bids {view.lore}/4</span>
		{#if view.languages.length}<span>Languages: {view.languages.join(', ')}</span>{/if}
	</section>

	{#if view.notes}
		<section><h2>Notes</h2><p>{view.notes}</p></section>
	{/if}
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
		font-family: var(--font-heading);
		font-size: 2rem;
		line-height: 1;
	}
	.attr-name {
		font-size: 0.8rem;
		color: var(--ink-soft);
	}
	.statusline {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin: 0.75rem 0;
	}
	.badge {
		padding: 0.15rem 0.6rem;
		border-radius: 999px;
		font-size: 0.8rem;
		font-family: var(--font-subhead);
		border: 1px solid var(--accent);
		color: var(--accent);
		background: color-mix(in oklab, var(--accent) 8%, var(--parchment));
	}
	.badge.aff {
		border-style: dashed;
	}
	section {
		margin: 1rem 0;
	}
	h2 {
		display: flex;
		align-items: baseline;
		gap: 0.75rem;
		flex-wrap: wrap;
		font-size: 1rem;
		margin: 0 0 0.35rem;
		border-bottom: 1px solid color-mix(in oklab, var(--ink) 15%, transparent);
	}
	h3 {
		font-size: 0.82rem;
		margin: 0.5rem 0 0.2rem;
		color: var(--ink-soft);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		font-family: var(--font-subhead);
	}
	.load {
		font-size: 0.75rem;
		color: var(--ink-soft);
		font-family: var(--font-subhead);
		text-transform: none;
		letter-spacing: 0;
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
	li.wounded {
		text-decoration: line-through;
		text-decoration-color: var(--accent);
	}
	li.destroyed {
		opacity: 0.6;
	}
	.tag {
		font-size: 0.7rem;
		color: var(--ink-soft);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin-left: 0.3rem;
	}
	.tag.hurt {
		color: var(--accent);
	}
	.charge {
		color: var(--accent);
		margin-right: 0.2rem;
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		gap: 1rem;
		font-size: 0.85rem;
		color: var(--ink-soft);
	}
</style>
