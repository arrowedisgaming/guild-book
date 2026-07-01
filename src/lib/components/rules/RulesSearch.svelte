<script lang="ts">
	let { value = $bindable(''), placeholder = 'Search the rules…' } = $props();
</script>

<label class="search">
	<span class="sr-only">Search the rules</span>
	<input type="search" bind:value {placeholder} />
</label>

<style>
	.search input {
		width: 100%;
		padding: 0.6rem 0.8rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 4px;
		background: var(--parchment);
		font: inherit;
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
	}
</style>
