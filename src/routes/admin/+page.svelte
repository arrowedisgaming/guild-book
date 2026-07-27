<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const dateFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

	function when(value: Date | null): string {
		return value ? dateFormat.format(value) : '—';
	}

	let tiles = $derived([
		{ label: 'Users', value: data.summary.totalUsers },
		{ label: 'Active (7d)', value: data.summary.activeUsers },
		{ label: 'Adventurers', value: data.summary.totalCharacters },
		{ label: 'Complete', value: data.summary.completedCharacters },
		{ label: 'Drafts', value: data.summary.draftCharacters },
		{ label: 'New (7d)', value: data.summary.newCharacters },
		{ label: 'Denizens', value: data.summary.totalDenizens }
	]);

	function pageHref(key: string, value: number): string {
		const params = new URLSearchParams({
			usersPage: String(data.usersPage),
			charactersPage: String(data.charactersPage),
			userSort: data.userSort,
			characterSort: data.characterSort
		});
		params.set(key, String(value));
		return `?${params}`;
	}
</script>

<svelte:head>
	<title>Admin — Guild Book</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<h1>Admin</h1>

<ul class="tiles">
	{#each tiles as tile (tile.label)}
		<li><span class="value">{tile.value}</span><span class="label">{tile.label}</span></li>
	{/each}
</ul>

<h2>Users</h2>
<div class="scroller">
	<table>
		<thead>
			<tr>
				<th>Name</th><th>Email</th><th>First seen</th><th>Last seen</th>
				<th>Logins</th><th>Adventurers</th>
			</tr>
		</thead>
		<tbody>
			{#each data.users as row (row.id)}
				<tr>
					<td>{row.name ?? '—'}</td>
					<td>{row.email ?? '—'}</td>
					<td>{when(row.firstSeenAt)}</td>
					<td>{when(row.lastSeenAt)}</td>
					<td>{row.loginCount}</td>
					<td>{row.characterCount}</td>
				</tr>
			{:else}
				<tr><td colspan="6">No users yet.</td></tr>
			{/each}
		</tbody>
	</table>
</div>
<nav class="pager">
	{#if data.usersPage > 1}<a href={pageHref('usersPage', data.usersPage - 1)}>Previous</a>{/if}
	<span>Page {data.usersPage}</span>
	{#if data.users.length === data.pageSize}
		<a href={pageHref('usersPage', data.usersPage + 1)}>Next</a>
	{/if}
</nav>

<h2>Adventurers</h2>
<div class="scroller">
	<table>
		<thead>
			<tr>
				<th>Name</th><th>Kith</th><th>Path</th><th>Owner</th>
				<th>State</th><th>Created</th><th>Updated</th>
			</tr>
		</thead>
		<tbody>
			{#each data.characters as row (row.id)}
				<tr>
					<td>{row.name || '—'}</td>
					<td>{row.kith || '—'}</td>
					<td>{row.path || '—'}</td>
					<td>{row.ownerName ?? row.ownerEmail ?? '—'}</td>
					<td>
						{row.isDraft ? 'Draft' : 'Complete'}{row.isArchived ? ' · Archived' : ''}
					</td>
					<td>{when(row.createdAt)}</td>
					<td>{when(row.updatedAt)}</td>
				</tr>
			{:else}
				<tr><td colspan="7">No adventurers yet.</td></tr>
			{/each}
		</tbody>
	</table>
</div>
<nav class="pager">
	{#if data.charactersPage > 1}
		<a href={pageHref('charactersPage', data.charactersPage - 1)}>Previous</a>
	{/if}
	<span>Page {data.charactersPage}</span>
	{#if data.characters.length === data.pageSize}
		<a href={pageHref('charactersPage', data.charactersPage + 1)}>Next</a>
	{/if}
</nav>

<style>
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr));
		gap: 0.75rem;
		list-style: none;
		margin: 1.5rem 0 2.5rem;
		padding: 0;
	}
	.tiles li {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		padding: 0.85rem;
		background: var(--surface);
		border: 1px solid color-mix(in oklab, var(--ink) 15%, transparent);
		border-radius: 0.4rem;
	}
	.value {
		font-family: var(--font-display);
		font-size: 1.75rem;
		line-height: 1;
	}
	.label {
		font-size: 0.75rem;
		color: var(--ink-soft);
	}
	/* Wide tables scroll inside their own container; the page body never
	 * scrolls sideways. */
	.scroller {
		overflow-x: auto;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.85rem;
		white-space: nowrap;
	}
	th,
	td {
		text-align: left;
		padding: 0.45rem 0.75rem 0.45rem 0;
		border-bottom: 1px solid color-mix(in oklab, var(--ink) 12%, transparent);
	}
	th {
		font-family: var(--font-subhead);
		color: var(--ink-soft);
	}
	.pager {
		display: flex;
		align-items: baseline;
		gap: 1rem;
		margin: 0.75rem 0 2.5rem;
		font-size: 0.85rem;
		color: var(--ink-soft);
	}
</style>
