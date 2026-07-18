<script lang="ts">
	let {
		adventurers,
		hasActiveTenure
	}: {
		adventurers: Array<{ id: string; name: string }>;
		hasActiveTenure: boolean;
	} = $props();

	function confirmReplacement(event: SubmitEvent) {
		if (hasActiveTenure && !confirm('Replace your current adventurer? The current tenure will end.')) {
			event.preventDefault();
		}
	}
</script>

<section class="picker" aria-labelledby="adventurer-picker-heading">
	<h2 id="adventurer-picker-heading">
		{hasActiveTenure ? 'Replace your adventurer' : 'Choose your adventurer'}
	</h2>
	{#if adventurers.length > 0}
		<form
			method="POST"
			action={hasActiveTenure ? '?/replace' : '?/attach'}
			onsubmit={confirmReplacement}
		>
			<label for="campaign-adventurer">Adventurer</label>
			<select id="campaign-adventurer" name="characterId" required>
				{#each adventurers as adventurer (adventurer.id)}
					<option value={adventurer.id}>{adventurer.name}</option>
				{/each}
			</select>
			<button type="submit">
				{hasActiveTenure ? 'Replace adventurer' : 'Attach adventurer'}
			</button>
		</form>
	{:else}
		<p class="empty">
			{hasActiveTenure
				? 'You have no other eligible adventurers.'
				: 'You have no eligible adventurers yet.'}
			<a href="/create/hmtw/identity">Create one →</a>
		</p>
	{/if}
</section>

<style>
	.picker {
		padding: 1.25rem;
		border: 1px solid color-mix(in oklab, var(--accent) 35%, transparent);
		background: color-mix(in oklab, var(--accent) 4%, var(--parchment));
	}
	h2 {
		margin: 0 0 0.75rem;
		font-size: 1.25rem;
	}
	form {
		display: grid;
		grid-template-columns: minmax(10rem, 1fr) auto;
		gap: 0.5rem 0.75rem;
		align-items: end;
	}
	label {
		grid-column: 1 / -1;
		font-family: var(--font-subhead);
		font-size: 0.85rem;
	}
	select,
	button {
		min-height: 2.5rem;
		padding: 0.5rem 0.7rem;
		border: 1px solid color-mix(in oklab, var(--ink) 28%, transparent);
		border-radius: 3px;
		font: inherit;
	}
	select {
		background: var(--parchment);
	}
	button {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--parchment);
		font-family: var(--font-subhead);
		cursor: pointer;
	}
	.empty {
		margin: 0;
		color: var(--ink-soft);
	}
	.empty a {
		margin-left: 0.35rem;
	}
	@media (max-width: 34rem) {
		form {
			grid-template-columns: 1fr;
		}
	}
</style>
