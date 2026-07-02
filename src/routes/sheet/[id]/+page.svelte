<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import CharacterSheet from '$lib/components/character/CharacterSheet.svelte';
	import SheetActions from '$lib/components/character/SheetActions.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let finalizing = $state(false);
	let finalizeError = $state('');

	/**
	 * Promote the draft to a finished adventurer: refetch the full blob, flip
	 * isDraft off, and PUT it back. The server runs the final-validation gate on
	 * non-draft saves, so an incomplete draft is rejected with actionable errors
	 * rather than saved broken. `expectedUpdatedAt` guards against clobbering an
	 * edit made in another tab between the fetch and the save.
	 */
	async function saveAsFinal() {
		finalizing = true;
		finalizeError = '';
		try {
			const res = await fetch(`/api/characters/${data.id}`);
			if (!res.ok) {
				finalizeError = 'Could not load the adventurer — try again.';
				return;
			}
			const row = (await res.json()) as { data: Record<string, unknown>; updatedAt: string };
			const character = { ...row.data, isDraft: false };

			const put = await fetch(`/api/characters/${data.id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					character,
					expectedUpdatedAt: new Date(row.updatedAt).getTime()
				})
			});
			if (put.ok) {
				await invalidateAll();
				return;
			}
			const body = (await put.json().catch(() => ({}))) as { message?: string };
			finalizeError = body.message ?? 'Could not save as final.';
		} catch {
			finalizeError = 'Network error — try again.';
		} finally {
			finalizing = false;
		}
	}
</script>

<svelte:head><title>{data.view.name} — Guild Book</title></svelte:head>

<div class="sheet-page">
	<p class="crumb"><a href="/characters">← My Adventurers</a></p>

	{#if data.isDraft}
		<div class="draft-bar">
			<p class="draft-note">
				This adventurer is a <strong>draft</strong> — finalize it to enable sharing.
			</p>
			<button type="button" class="finalize" disabled={finalizing} onclick={saveAsFinal}>
				{finalizing ? 'Saving…' : 'Save as final'}
			</button>
		</div>
		{#if finalizeError}
			<p class="finalize-error">
				{finalizeError.replace('Creation-rule violation: ', 'Still missing: ')}
			</p>
		{/if}
	{/if}

	<CharacterSheet view={data.view} />

	<div class="actions-wrap">
		<SheetActions view={data.view} characterId={data.id} shareId={data.shareId} isDraft={data.isDraft} />
	</div>
</div>

<style>
	.sheet-page {
		max-width: 48rem;
		margin: 0 auto;
	}
	.crumb {
		font-family: var(--font-subhead);
		font-size: 0.9rem;
	}
	.crumb a {
		color: var(--ink-soft);
		text-decoration: none;
	}
	.draft-bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		margin-bottom: 1rem;
		padding: 0.7rem 1rem;
		border: 1px solid color-mix(in oklab, var(--accent) 45%, transparent);
		border-radius: 4px;
		background: color-mix(in oklab, var(--accent) 6%, var(--parchment));
	}
	.draft-note {
		margin: 0;
		color: var(--ink-soft);
		font-size: 0.9rem;
	}
	.finalize {
		padding: 0.5rem 1.1rem;
		border: 1px solid var(--accent);
		border-radius: 3px;
		background: var(--accent);
		color: var(--parchment);
		font-family: var(--font-subhead);
		font-size: 1rem;
		cursor: pointer;
	}
	.finalize:disabled {
		opacity: 0.55;
		cursor: default;
	}
	.finalize-error {
		margin: 0 0 1rem;
		color: var(--accent);
		font-size: 0.9rem;
	}
	.actions-wrap {
		margin-top: 1.25rem;
	}
</style>
