import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '$lib/utils/markdown';

describe('renderMarkdown', () => {
	it('renders bold and wraps in a paragraph', () => {
		expect(renderMarkdown('A **success** at 14+.')).toBe('<p>A <strong>success</strong> at 14+.</p>');
	});

	it('splits paragraphs on blank lines', () => {
		expect(renderMarkdown('One.\n\nTwo.')).toBe('<p>One.</p>\n<p>Two.</p>');
	});

	it('escapes HTML before applying emphasis (no injection)', () => {
		const out = renderMarkdown('<script>alert(1)</script> **safe**');
		expect(out).toContain('&lt;script&gt;');
		expect(out).not.toContain('<script>');
		expect(out).toContain('<strong>safe</strong>');
	});
});
