<script lang="ts">
	import { exportDenizenToMarkdown } from '$lib/export/denizen-markdown-export';
	import { downloadDenizenPDF } from '$lib/export/denizen-pdf-export';
	import { announce } from '$lib/stores/announcer';
	import type { DenizenDefinition } from '$lib/types/content-pack';

	let {
		denizen,
		themeName,
		threatName
	}: { denizen: DenizenDefinition; themeName: string; threatName: string } = $props();

	let copied = $state(false);
	let copying = $state(false);
	let generatingPdf = $state(false);

	async function copyMarkdown() {
		if (copying) return;
		copying = true;
		try {
			await navigator.clipboard.writeText(exportDenizenToMarkdown(denizen, themeName, threatName));
			copied = true;
			announce('Markdown copied to clipboard.');
			setTimeout(() => (copied = false), 2000);
		} catch {
			announce('Could not copy — the browser blocked clipboard access. Try “Download .md” instead.');
		} finally {
			copying = false;
		}
	}

	function downloadMarkdown() {
		const markdown = exportDenizenToMarkdown(denizen, themeName, threatName);
		const blob = new Blob([markdown], { type: 'text/markdown' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `${(denizen.name || 'denizen').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.md`;
		a.click();
		URL.revokeObjectURL(url);
	}

	async function downloadPdf() {
		if (generatingPdf) return;
		generatingPdf = true;
		try {
			await downloadDenizenPDF(denizen, themeName, threatName);
		} catch {
			announce('PDF generation failed — check your connection and try again.');
		} finally {
			generatingPdf = false;
		}
	}
</script>

<div class="export">
	<button type="button" disabled={copying} onclick={copyMarkdown}>
		{copied ? 'Copied!' : 'Copy Markdown'}
	</button>
	<button type="button" onclick={downloadMarkdown}>Download .md</button>
	<button type="button" disabled={generatingPdf} onclick={downloadPdf}>
		{generatingPdf ? 'Preparing PDF…' : 'Download PDF'}
	</button>
</div>

<style>
	.export {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin: 1rem 0;
	}
	button {
		font: inherit;
		font-family: var(--font-subhead);
		font-size: 0.9rem;
		padding: 0.4rem 0.9rem;
		border: 1px solid color-mix(in oklab, var(--ink) 25%, transparent);
		border-radius: 4px;
		background: none;
		color: var(--ink);
		cursor: pointer;
	}
	button:hover {
		border-color: var(--accent);
	}
	button:disabled {
		opacity: 0.6;
		cursor: wait;
	}
</style>
