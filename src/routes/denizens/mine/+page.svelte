<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { denizenBuilder } from '$lib/stores/denizen-builder';
	import { announce } from '$lib/stores/announcer';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let busyId = $state<string | null>(null);

	async function edit(id: string) {
		busyId = id;
		try {
			const res = await fetch(`/api/denizens/${id}`);
			if (!res.ok) {
				announce('Could not load that denizen for editing.');
				return;
			}
			const row = (await res.json()) as { data: unknown; version: number };
			denizenBuilder.loadForEditing(row.data, id, row.version);
			await goto('/denizens/build');
		} catch {
			announce('Could not load that denizen — check your connection and try again.');
		} finally {
			busyId = null;
		}
	}

	async function remove(id: string, name: string) {
		if (!confirm(`Archive "${name}"? It will be removed from this list.`)) return;
		busyId = id;
		try {
			const res = await fetch(`/api/denizens/${id}`, { method: 'DELETE' });
			if (res.ok) await invalidateAll();
			else announce('Could not archive that denizen.');
		} finally {
			busyId = null;
		}
	}

	const dateLabel = (value: string | Date) =>
		new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
</script>

<svelte:head><title>My Denizens — Guild Book</title></svelte:head>

<section class="roster">
	<div class="head">
		<h1>My Denizens</h1>
		<!-- The detach intent rides in the URL, not a click handler: middle-click and
		     "open in new tab" never fire onclick, and the builder rehydrates its saved-row
		     binding from localStorage — so a handler-only detach lets the fresh tab save
		     straight over the row this link sits next to. "New" must never overwrite. -->
		<a class="new" href="/denizens/build?new=1">New denizen</a>
	</div>

	{#if data.denizens.length === 0}
		<p class="empty">
			No denizens yet.
			<a href="/denizens/build?new=1">Mix your first →</a>
		</p>
	{:else}
		<ul class="list">
			{#each data.denizens as d (d.id)}
				<li class="row">
					<div class="info">
						<a class="name" href="/denizens/mine/{d.id}">{d.name}</a>
						<span class="tags">
							{#if d.themeName}<span class="muted">{d.themeName}</span>{/if}
							{#if d.threatName}<span class="muted">{d.threatName}</span>{/if}
							<span class="muted">updated {dateLabel(d.updatedAt)}</span>
						</span>
					</div>
					<div class="actions">
						<a href="/denizens/mine/{d.id}" aria-label={`Open ${d.name}`}>Open</a>
						<button
							type="button"
							aria-label={`Edit ${d.name}`}
							disabled={busyId === d.id}
							onclick={() => edit(d.id)}
						>
							Edit
						</button>
						<button
							type="button"
							aria-label={`Archive ${d.name}`}
							disabled={busyId === d.id}
							onclick={() => remove(d.id, d.name)}
						>
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
		padding: 0.7rem 0;
		border-bottom: 1px solid color-mix(in oklab, var(--ink) 12%, transparent);
	}
	.info {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}
	.name {
		font-family: var(--font-subhead);
		font-size: 1.05rem;
	}
	.tags {
		display: flex;
		gap: 0.6rem;
		font-size: 0.8rem;
	}
	.muted {
		color: var(--ink-soft);
	}
	.actions {
		display: flex;
		gap: 0.75rem;
		align-items: baseline;
	}
	.actions a,
	.actions button {
		font: inherit;
		font-family: var(--font-subhead);
		font-size: 0.85rem;
		border: none;
		background: none;
		color: var(--accent);
		cursor: pointer;
		text-decoration: underline;
		text-underline-offset: 2px;
		padding: 0;
	}
	.actions button:disabled {
		opacity: 0.5;
		cursor: wait;
	}
</style>
