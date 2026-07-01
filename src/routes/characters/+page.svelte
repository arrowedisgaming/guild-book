<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let busyId = $state<string | null>(null);

	async function remove(id: string, name: string) {
		if (!confirm(`Archive "${name}"? It will be removed from this list.`)) return;
		busyId = id;
		try {
			const res = await fetch(`/api/characters/${id}`, { method: 'DELETE' });
			if (res.ok) await invalidateAll();
			else alert('Could not archive that adventurer.');
		} finally {
			busyId = null;
		}
	}
</script>

<svelte:head><title>My Adventurers — Guild Book</title></svelte:head>

<section class="roster">
	<div class="head">
		<h1>My Adventurers</h1>
		<a class="new" href="/create/hmtw/identity">New adventurer</a>
	</div>

	{#if data.characters.length === 0}
		<p class="empty">No adventurers yet. <a href="/create/hmtw/identity">Create your first →</a></p>
	{:else}
		<ul class="list">
			{#each data.characters as c (c.id)}
				<li class="row">
					<div class="info">
						<a class="name" href="/sheet/{c.id}">{c.name}</a>
						<span class="tags">
							{#if c.isDraft}<span class="tag draft">Draft</span>{/if}
							{#if c.isPublic}<span class="tag">Shared</span>{/if}
							{#if c.kith}<span class="muted">{c.kith}</span>{/if}
							{#if c.path}<span class="muted">{c.path}</span>{/if}
						</span>
					</div>
					<div class="actions">
						<a href="/sheet/{c.id}">Open</a>
						<button type="button" disabled={busyId === c.id} onclick={() => remove(c.id, c.name)}>
							Archive
						</button>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.roster {
		max-width: 44rem;
		margin: 0 auto;
	}
	.head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
	}
	.new {
		font-family: var(--font-subhead);
	}
	.empty {
		color: var(--ink-soft);
	}
	.list {
		list-style: none;
		padding: 0;
		margin: 1rem 0 0;
	}
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.75rem 0;
		border-bottom: 1px solid color-mix(in oklab, var(--ink) 15%, transparent);
	}
	.name {
		font-size: 1.1rem;
		font-family: var(--font-heading);
	}
	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 0.2rem;
		font-size: 0.8rem;
	}
	.tag {
		padding: 0.05rem 0.4rem;
		border: 1px solid color-mix(in oklab, var(--ink) 20%, transparent);
		border-radius: 999px;
	}
	.tag.draft {
		color: var(--accent);
		border-color: color-mix(in oklab, var(--accent) 50%, transparent);
	}
	.muted {
		color: var(--ink-soft);
	}
	.actions {
		display: flex;
		gap: 0.75rem;
		align-items: center;
		font-family: var(--font-subhead);
		font-size: 0.9rem;
	}
	.actions button {
		border: none;
		background: none;
		color: var(--accent);
		cursor: pointer;
		font: inherit;
	}
	.actions button:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
