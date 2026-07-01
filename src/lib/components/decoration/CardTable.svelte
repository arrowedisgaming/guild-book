<script lang="ts">
	// A card-style reference table matching the book's rank-keyed tables
	// (e.g. "Card | Result"). Small-caps heading, ruled cells, alternating rows.
	interface Props {
		columns: string[];
		rows: (string | number)[][];
		caption?: string;
	}
	let { columns, rows, caption }: Props = $props();
</script>

<table class="card-table">
	{#if caption}<caption>{caption}</caption>{/if}
	<thead>
		<tr>{#each columns as col}<th scope="col">{col}</th>{/each}</tr>
	</thead>
	<tbody>
		{#each rows as row}
			<tr>{#each row as cell, i}<td class:first={i === 0}>{cell}</td>{/each}</tr>
		{/each}
	</tbody>
</table>

<style>
	.card-table {
		width: 100%;
		border-collapse: collapse;
		margin: 1rem 0;
		border: 1px solid color-mix(in oklab, var(--ink) 40%, transparent);
	}
	caption {
		font-family: var(--font-subhead);
		font-weight: 700;
		text-align: left;
		padding-bottom: 0.4rem;
	}
	thead th {
		font-family: var(--font-heading);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		font-size: 0.9rem;
		text-align: left;
		padding: 0.4rem 0.7rem;
		background: color-mix(in oklab, var(--ink) 72%, var(--accent));
		color: var(--parchment);
	}
	td {
		padding: 0.4rem 0.7rem;
		border-top: 1px solid color-mix(in oklab, var(--ink) 20%, transparent);
		vertical-align: top;
	}
	td.first {
		font-family: var(--font-subhead);
		white-space: nowrap;
		width: 1%;
	}
	tbody tr:nth-child(even) {
		background: color-mix(in oklab, var(--ink) 6%, transparent);
	}
</style>
