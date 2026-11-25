<script lang="ts">
	import type { CharacterView } from '$lib/types/character-view';

	// name and pronouns come from the live working copy so the heading follows
	// the Story fields as they are typed; kin, path and attributes are fixed at
	// creation and come from the server's view.
	let { name, pronouns, view }: { name: string; pronouns: string; view: CharacterView } = $props();

	const kin = $derived(view.kin ? `${view.kin}${view.kith ? ` (${view.kith})` : ''}` : '');
</script>

<header class="sheet-header">
	<h1>{name.trim() || 'Unnamed adventurer'}</h1>
	{#if pronouns || kin || view.path}
		<p class="sub">
			{#if pronouns}<span>{pronouns}</span>{/if}
			{#if kin}<span>{kin}</span>{/if}
			{#if view.path}<span>{view.path}</span>{/if}
		</p>
	{/if}
	<dl class="attributes">
		{#each view.attributes as attr (attr.id)}
			<div class="attr">
				<dt>{attr.name}</dt>
				<dd>{attr.value}</dd>
			</div>
		{/each}
	</dl>
</header>

<style>
	.sheet-header {
		margin: 1rem 0 0;
	}
	h1 {
		margin: 0;
		font-size: 2.2rem;
		line-height: 1.1;
		overflow-wrap: anywhere;
		text-wrap: balance;
	}
	.sub {
		display: flex;
		flex-wrap: wrap;
		gap: 0.2rem 1rem;
		margin: 0.35rem 0 0;
		color: var(--ink-soft);
		font-family: var(--font-subhead);
	}
	/* One ruled band, as on a printed sheet: the four suits share a row and are
	 * divided by rules, not boxed one by one. */
	.attributes {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		margin: 0.9rem 0 0;
		border-block: 1px solid color-mix(in oklab, var(--ink) 30%, transparent);
	}
	.attr {
		display: flex;
		flex-direction: column-reverse;
		align-items: center;
		gap: 0.15rem;
		padding: 0.6rem 0.25rem;
	}
	.attr + .attr {
		border-inline-start: 1px solid color-mix(in oklab, var(--ink) 18%, transparent);
	}
	dt {
		font-family: var(--font-subhead);
		font-size: 0.85rem;
		color: var(--ink-soft);
	}
	dd {
		margin: 0;
		font-family: var(--font-heading);
		font-size: 2.2rem;
		line-height: 1;
	}
	@media (max-width: 30rem) {
		h1 {
			font-size: 1.75rem;
		}
		dd {
			font-size: 1.8rem;
		}
	}
</style>
