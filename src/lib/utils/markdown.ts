/**
 * Minimal, safe Markdown renderer for the rules-reference bodies. Handles the
 * small subset the content pack uses — paragraphs, bold, italics, inline code —
 * and HTML-escapes first so the output is safe to pass to {@html} even though
 * the content is authored, not user-supplied.
 */

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

/** Inline emphasis: **bold**, *italic*, `code`. Input is already escaped. */
function renderInline(escaped: string): string {
	return escaped
		.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
		.replace(/`(.+?)`/g, '<code>$1</code>')
		.replace(/(^|[^*])\*(?!\*)(.+?)\*(?!\*)/g, '$1<em>$2</em>');
}

/** Render a markdown string into safe HTML (paragraphs on blank lines). */
export function renderMarkdown(text: string): string {
	return text
		.split(/\n{2,}/)
		.map((block) => `<p>${renderInline(escapeHtml(block)).replace(/\n/g, '<br>')}</p>`)
		.join('\n');
}
