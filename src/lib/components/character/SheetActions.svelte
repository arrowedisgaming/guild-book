<script lang="ts">
	import { downloadPDF } from '$lib/export/pdf-export';
	import { exportToMarkdown } from '$lib/export/markdown-export';
	import ShareDialog from './ShareDialog.svelte';
	import type { CharacterView } from '$lib/types/character-view';

	interface Props {
		view: CharacterView;
		characterId: string;
		shareId: string | null;
		isDraft: boolean;
	}
	let { view, characterId, shareId, isDraft }: Props = $props();

	let pdfBusy = $state(false);
	let showShare = $state(false);

	async function exportPdf() {
		pdfBusy = true;
		try {
			await downloadPDF(view);
		} finally {
			pdfBusy = false;
		}
	}

	function exportMarkdown() {
		const md = exportToMarkdown(view);
		const blob = new Blob([md], { type: 'text/markdown' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `${(view.name || 'adventurer').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.md`;
		a.click();
		URL.revokeObjectURL(url);
	}
</script>

<div class="actions">
	<button type="button" disabled={pdfBusy} onclick={exportPdf}>
		{pdfBusy ? 'Building PDF…' : 'Download PDF'}
	</button>
	<button type="button" onclick={exportMarkdown}>Download Markdown</button>
	<button type="button" class:active={showShare} onclick={() => (showShare = !showShare)}>
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
	.actions button {
		padding: 0.45rem 0.9rem;
		border: 1px solid color-mix(in oklab, var(--accent) 60%, transparent);
		border-radius: 3px;
		background: transparent;
		color: var(--accent);
		font-family: var(--font-subhead);
		cursor: pointer;
	}
	.actions button:disabled {
		opacity: 0.55;
		cursor: default;
	}
	.actions button.active {
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
