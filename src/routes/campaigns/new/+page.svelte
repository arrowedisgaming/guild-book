<script lang="ts">
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();
</script>

<svelte:head><title>New Campaign — Guild Book</title></svelte:head>

<section class="new-campaign">
	<a class="back" href="/campaigns">← Campaigns</a>
	<p class="eyebrow">Open a new ledger</p>
	<h1>Create a campaign</h1>
	<p class="lede">Name the guild now. Its shared roster and invitation will be ready immediately.</p>

	{#if form?.message}<p class="error" role="alert">{form.message}</p>{/if}
	<form method="POST">
		<label for="campaign-name">Campaign name</label>
		<input id="campaign-name" name="name" maxlength="100" required value={form?.name ?? ''} />
		<label for="campaign-description">Description <span>optional</span></label>
		<textarea id="campaign-description" name="description" maxlength="2000" rows="5">{form?.description ?? ''}</textarea>
		<button type="submit">Create campaign</button>
	</form>
</section>

<style>
	.new-campaign {
		max-width: 36rem;
		margin: 0 auto;
	}
	.back {
		font-family: var(--font-subhead);
		font-size: 0.9rem;
	}
	.eyebrow {
		margin: 2rem 0 0;
		font-family: var(--font-subhead);
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--ink-soft);
	}
	h1 {
		margin: 0;
	}
	.lede {
		color: var(--ink-soft);
	}
	form {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		margin-top: 1.5rem;
	}
	label {
		margin-top: 0.65rem;
		font-family: var(--font-subhead);
	}
	label span {
		color: var(--ink-soft);
		font-size: 0.8rem;
	}
	input,
	textarea {
		padding: 0.65rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 3px;
		background: var(--parchment);
		color: var(--ink);
		font: inherit;
	}
	button {
		align-self: start;
		margin-top: 0.8rem;
		padding: 0.65rem 1rem;
		border: 1px solid var(--accent);
		background: var(--accent);
		color: var(--parchment);
		font-family: var(--font-subhead);
		cursor: pointer;
	}
	.error {
		color: var(--danger, var(--accent));
	}
</style>
