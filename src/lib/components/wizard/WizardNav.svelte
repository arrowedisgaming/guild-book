<script lang="ts">
	interface Props {
		backPath?: string | null;
		continueLabel?: string;
		continueDisabled?: boolean;
		onContinue: () => void;
	}
	let {
		backPath = null,
		continueLabel = 'Continue',
		continueDisabled = false,
		onContinue
	}: Props = $props();
</script>

<div class="nav">
	{#if backPath}
		<a class="back" href={backPath}>← Back</a>
	{:else}
		<span></span>
	{/if}
	<button type="button" class="continue" disabled={continueDisabled} onclick={onContinue}>
		{continueLabel}
	</button>
</div>

<style>
	.nav {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin-top: 2rem;
		padding-top: 1.25rem;
		border-top: 1px solid color-mix(in oklab, var(--ink) 15%, transparent);
	}
	.back {
		font-family: var(--font-subhead);
		color: var(--ink-soft);
		text-decoration: none;
	}
	.continue {
		padding: 0.6rem 1.4rem;
		border: 1px solid var(--accent);
		border-radius: 3px;
		background: var(--accent);
		color: var(--parchment);
		font-family: var(--font-subhead);
		font-size: 1.1rem;
		cursor: pointer;
	}
	.continue:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
</style>
