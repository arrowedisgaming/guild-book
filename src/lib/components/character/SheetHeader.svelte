<script lang="ts">
	import type { CharacterView } from '$lib/types/character-view';

	// name and pronouns come from the live working copy so the heading follows
	// the Story fields as they are typed; kin, path and attributes are fixed at
	// creation and come from the server's view.
	let { name, pronouns, view }: { name: string; pronouns: string; view: CharacterView } = $props();

	const kin = $derived(view.kin ? `${view.kin}${view.kith ? ` (${view.kith})` : ''}` : '');
</script>

<header class="sheet-header">
	<div class="who">
		<h1>{name.trim() || 'Unnamed adventurer'}</h1>
		{#if pronouns || kin || view.path}
			<p class="sub">
				{#if pronouns}<span>{pronouns}</span>{/if}
				{#if kin}<span>{kin}</span>{/if}
				{#if view.path}<span>{view.path}</span>{/if}
			</p>
		{/if}
	</div>
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
	/* Compact on purpose: this header stays pinned while the sheet scrolls. */
	.sheet-header {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.4rem 1.5rem;
	}
	.who {
		min-width: 0;
	}
	h1 {
		margin: 0;
		font-size: 1.8rem;
		line-height: 1.1;
		overflow-wrap: anywhere;
	}
	.sub {
		display: flex;
		flex-wrap: wrap;
		gap: 0 0.9rem;
		margin: 0.2rem 0 0;
		color: var(--ink-soft);
		font-family: var(--font-subhead);
		font-size: 0.9rem;
	}
	/* One ruled row, as on a printed sheet: the four suits are divided by
	 * rules, not boxed one by one. */
	.attributes {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, auto));
		margin: 0;
	}
	.attr {
		display: flex;
		flex-direction: column-reverse;
		align-items: center;
		padding: 0.1rem 0.9rem;
	}
	.attr + .attr {
		border-inline-start: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
	}
	dt {
		font-family: var(--font-subhead);
		font-size: 0.8rem;
		color: var(--ink-soft);
	}
	dd {
		margin: 0;
		font-family: var(--font-heading);
		font-size: 1.7rem;
		line-height: 1;
	}
	@media (max-width: 40rem) {
		h1 {
			font-size: 1.35rem;
		}
		.sub {
			font-size: 0.8rem;
		}
		/* Full width, value beside its name, so the row is one line tall. */
		.attributes {
			flex: 1 0 100%;
			grid-template-columns: repeat(4, minmax(0, 1fr));
		}
		.attr {
			flex-direction: row-reverse;
			justify-content: center;
			align-items: baseline;
			gap: 0.3rem;
			padding: 0.1rem 0.2rem;
		}
		dt {
			font-size: 0.75rem;
		}
		dd {
			font-size: 1.3rem;
		}
	}
</style>
