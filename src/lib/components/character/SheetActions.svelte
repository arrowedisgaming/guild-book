<script lang="ts">
	import CharacterExportButtons from './CharacterExportButtons.svelte';
	import ShareDialog from './ShareDialog.svelte';
	import type { CharacterView } from '$lib/types/character-view';

	interface Props {
		view: CharacterView;
		characterId: string;
		shareId: string | null;
		isDraft: boolean;
	}
	let { view, characterId, shareId, isDraft }: Props = $props();

	let showShare = $state(false);
</script>

<div class="actions">
	<CharacterExportButtons getView={() => view} />
	<button
		type="button"
		class="share"
		class:active={showShare}
		onclick={() => (showShare = !showShare)}
	>
		Share…
	</button>
</div>

{#if showShare}
	<div class="share-panel">
		<ShareDialog {characterId} {shareId} {isDraft} />
	</div>
{/if}

<style>
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.share {
		padding: 0.45rem 0.9rem;
		border: 1px solid color-mix(in oklab, var(--accent) 60%, transparent);
		border-radius: 3px;
		background: transparent;
		color: var(--accent);
		font-family: var(--font-subhead);
		cursor: pointer;
	}
	.share.active {
		background: color-mix(in oklab, var(--accent) 10%, var(--parchment));
	}
	.share-panel {
		margin-top: 0.75rem;
		padding: 0.9rem 1rem;
		border: 1px solid color-mix(in oklab, var(--ink) 18%, transparent);
		border-radius: 4px;
		max-width: 30rem;
	}
</style>
