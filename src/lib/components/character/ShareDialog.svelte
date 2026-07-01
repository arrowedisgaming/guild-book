<script lang="ts">
	import { invalidateAll } from '$app/navigation';

	interface Props {
		characterId: string;
		shareId: string | null;
		isDraft: boolean;
	}
	let { characterId, shareId, isDraft }: Props = $props();

	let busy = $state(false);
	let error = $state('');
	let copied = $state(false);

	let shareUrl = $derived(
		shareId && typeof window !== 'undefined' ? `${window.location.origin}/s/${shareId}` : null
	);

	async function enable() {
		busy = true;
		error = '';
		try {
			const res = await fetch(`/api/characters/${characterId}/share`, { method: 'POST' });
			if (!res.ok) {
				const b = (await res.json().catch(() => ({}))) as { message?: string };
				error = b.message ?? 'Could not create a share link.';
			} else {
				await invalidateAll();
			}
		} finally {
			busy = false;
		}
	}

	async function disable() {
		busy = true;
		error = '';
		try {
			const res = await fetch(`/api/characters/${characterId}/share`, { method: 'DELETE' });
			if (res.ok) await invalidateAll();
			else error = 'Could not stop sharing.';
		} finally {
			busy = false;
		}
	}

	async function copy() {
		if (!shareUrl) return;
		await navigator.clipboard.writeText(shareUrl);
		copied = true;
		setTimeout(() => (copied = false), 1500);
	}
</script>

<div class="share">
	{#if isDraft}
		<p class="note">Finish this adventurer (save as complete) to share a public link.</p>
	{:else if shareId && shareUrl}
		<p class="lbl">Anyone with this link can view a read-only sheet:</p>
		<div class="row">
			<input type="text" readonly value={shareUrl} />
			<button type="button" onclick={copy}>{copied ? 'Copied!' : 'Copy'}</button>
		</div>
		<button type="button" class="revoke" disabled={busy} onclick={disable}>Stop sharing</button>
	{:else}
		<button type="button" class="primary" disabled={busy} onclick={enable}>
			{busy ? 'Creating…' : 'Create share link'}
		</button>
	{/if}
	{#if error}<p class="error">{error}</p>{/if}
</div>

<style>
	.share {
		margin-top: 0.5rem;
	}
	.lbl,
	.note {
		font-size: 0.85rem;
		color: var(--ink-soft);
		margin: 0 0 0.5rem;
	}
	.row {
		display: flex;
		gap: 0.4rem;
	}
	input {
		flex: 1;
		padding: 0.45rem 0.6rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 3px;
		background: var(--surface);
		font: inherit;
		font-size: 0.85rem;
	}
	button {
		padding: 0.45rem 0.9rem;
		border: 1px solid var(--accent);
		border-radius: 3px;
		background: transparent;
		color: var(--accent);
		font-family: var(--font-subhead);
		cursor: pointer;
	}
	button.primary {
		background: var(--accent);
		color: var(--parchment);
	}
	.revoke {
		margin-top: 0.5rem;
		border-color: color-mix(in oklab, var(--ink) 30%, transparent);
		color: var(--ink-soft);
	}
	.error {
		color: var(--accent);
		font-size: 0.85rem;
	}
</style>
