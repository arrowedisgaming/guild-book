<script lang="ts">
	import { downloadPDF } from '$lib/export/pdf-export';
	import { exportToMarkdown } from '$lib/export/markdown-export';
	import type { CharacterView } from '$lib/types/character-view';

	// beforeExport lets a page that saves as you type finish its pending save
	// first, so the file matches what is on screen rather than the last copy
	// the server sent. Resolving false means that save failed: nothing is
	// exported, because the file would silently be the older copy.
	let { getView, beforeExport }: { getView: () => CharacterView; beforeExport?: () => Promise<boolean> } = $props();
	let pdfBusy = $state(false);

	async function exportPdf() {
		pdfBusy = true;
		try {
			if (beforeExport && !(await beforeExport())) return;
			await downloadPDF(getView());
		} finally {
			pdfBusy = false;
		}
	}

	async function exportMarkdown() {
		if (beforeExport && !(await beforeExport())) return;
		const view = getView();
		const blob = new Blob([exportToMarkdown(view)], { type: 'text/markdown' });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement('a');
		anchor.href = url;
		anchor.download = `${(view.name || 'adventurer').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.md`;
		document.body.appendChild(anchor);
		anchor.click();
		anchor.remove();
		setTimeout(() => URL.revokeObjectURL(url), 0);
	}
</script>

<button type="button" disabled={pdfBusy} onclick={exportPdf}>
	{pdfBusy ? 'Building PDF…' : 'Download PDF'}
</button>
<button type="button" onclick={exportMarkdown}>Download Markdown</button>

<style>
	button {
		padding: 0.45rem 0.9rem;
		border: 1px solid color-mix(in oklab, var(--accent) 60%, transparent);
		border-radius: 3px;
		background: transparent;
		color: var(--accent);
		font-family: var(--font-subhead);
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.55;
		cursor: default;
	}
	@media (pointer: coarse) {
		button {
			min-height: 44px;
		}
	}
</style>
