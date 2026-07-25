/**
 * Minimal, safe Markdown renderer for the rules-reference bodies. Handles the
 * small subset the content pack uses — paragraphs, `-` bullet lists, bold,
 * italics, inline code — and HTML-escapes first so the output is safe to pass
 * to {@html} even though the content is authored, not user-supplied.
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

/** True when every non-empty line of a block is a `- ` bullet item. */
function isBulletBlock(block: string): boolean {
	const lines = block.split('\n').filter((l) => l.trim() !== '');
	return lines.length > 0 && lines.every((l) => /^\s*-\s+/.test(l));
}

/** Render a `- ` bullet block into a <ul>. Input block is raw (not yet escaped). */
function renderList(block: string): string {
	const items = block
		.split('\n')
		.filter((l) => l.trim() !== '')
		.map((l) => l.replace(/^\s*-\s+/, ''))
		.map((item) => {
			// Task items (`[ ] text`, `[ ] [ ] text`) render as real (inert)
			// checkboxes — used by e.g. the person Wounds note's option list.
			const task = /^((?:\[[ xX]\]\s*)+)(.*)$/.exec(item);
			if (task) {
				const boxes = (task[1].match(/\[[ xX]\]/g) ?? [])
					.map((box) => `<input type="checkbox" disabled${/[xX]/.test(box) ? ' checked' : ''} />`)
					.join(' ');
				return `<li class="task">${boxes} ${renderInline(escapeHtml(task[2]))}</li>`;
			}
			return `<li>${renderInline(escapeHtml(item))}</li>`;
		})
		.join('');
	return `<ul>${items}</ul>`;
}

/** True for a GitHub-style pipe table with a header separator row. */
function isTableBlock(block: string): boolean {
	const lines = block.split('\n').filter((line) => line.trim() !== '');
	return (
		lines.length >= 2 &&
		lines.every((line) => /^\s*\|.*\|\s*$/.test(line)) &&
		lines[1]
			.split('|')
			.slice(1, -1)
			.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell))
	);
}

function tableCells(line: string): string[] {
	return line
		.trim()
		.slice(1, -1)
		.split('|')
		.map((cell) => cell.trim());
}

/** Render the content pack's simple pipe tables without accepting raw HTML. */
function renderTable(block: string): string {
	const lines = block.split('\n').filter((line) => line.trim() !== '');
	const headers = tableCells(lines[0]);
	const rows = lines.slice(2).map(tableCells);
	const head = headers.map((cell) => `<th>${renderInline(escapeHtml(cell))}</th>`).join('');
	const body = rows
		.map(
			(row) =>
				`<tr>${headers.map((_, index) => `<td>${renderInline(escapeHtml(row[index] ?? ''))}</td>`).join('')}</tr>`
		)
		.join('');
	return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** A lone `##`–`######` line is a sub-heading; render below the article's own <h3>. */
function renderHeadingBlock(block: string): string | null {
	const m = /^(#{2,6})\s+(.+)$/.exec(block.trim());
	if (!m || block.trim().includes('\n')) return null;
	const level = Math.min(m[1].length + 2, 6); // ## -> h4, ### -> h5, …
	return `<h${level}>${renderInline(escapeHtml(m[2].trim()))}</h${level}>`;
}

/** Render a markdown string into safe HTML (paragraphs on blank lines, `##` sub-headings, `- ` lists). */
export function renderMarkdown(text: string): string {
	return text
		.split(/\n{2,}/)
		.map((block) => {
			const heading = renderHeadingBlock(block);
			if (heading) return heading;
			if (isTableBlock(block)) return renderTable(block);
			return isBulletBlock(block)
				? renderList(block)
				: `<p>${renderInline(escapeHtml(block)).replace(/\n/g, '<br>')}</p>`;
		})
		.join('\n');
}
