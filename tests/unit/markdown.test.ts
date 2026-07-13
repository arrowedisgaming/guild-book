import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '$lib/utils/markdown';

describe('renderMarkdown', () => {
	it('renders bold and wraps in a paragraph', () => {
		expect(renderMarkdown('A **success** at 14+.')).toBe('<p>A <strong>success</strong> at 14+.</p>');
	});

	it('splits paragraphs on blank lines', () => {
		expect(renderMarkdown('One.\n\nTwo.')).toBe('<p>One.</p>\n<p>Two.</p>');
	});

	it('renders dash blocks as unordered lists', () => {
		expect(renderMarkdown('Intro.\n\n- First\n- **Second**')).toBe(
			'<p>Intro.</p>\n<ul><li>First</li><li><strong>Second</strong></li></ul>'
		);
	});

	it('escapes HTML before applying emphasis (no injection)', () => {
		const out = renderMarkdown('<script>alert(1)</script> **safe**');
		expect(out).toContain('&lt;script&gt;');
		expect(out).not.toContain('<script>');
		expect(out).toContain('<strong>safe</strong>');
	});

	it('renders a "- " block as a <ul> with escaped, emphasised items', () => {
		expect(renderMarkdown('- First\n- **Second**')).toBe(
			'<ul><li>First</li><li><strong>Second</strong></li></ul>'
		);
	});

	it('keeps a bullet list and surrounding paragraphs as separate blocks', () => {
		const out = renderMarkdown('Lead in:\n\n- One\n- Two\n\nAfter.');
		expect(out).toBe('<p>Lead in:</p>\n<ul><li>One</li><li>Two</li></ul>\n<p>After.</p>');
	});

	it('does not treat a dash mid-sentence as a list', () => {
		expect(renderMarkdown('A well-trained soldier.')).toBe('<p>A well-trained soldier.</p>');
	});

	it('renders a lone "###" line as a sub-heading (### -> h5)', () => {
		expect(renderMarkdown('### Great success')).toBe('<h5>Great success</h5>');
	});

	it('renders sub-heading, paragraph, and list together', () => {
		const out = renderMarkdown('### Blind\n\nCannot see.\n\n- No missile attacks.');
		expect(out).toBe('<h5>Blind</h5>\n<p>Cannot see.</p>\n<ul><li>No missile attacks.</li></ul>');
	});

	it('renders pipe tables with escaped, emphasised cells', () => {
		const out = renderMarkdown('| Card | Result |\n|:---:|---|\n| I | **Good** |\n| II | <bad> |');
		expect(out).toBe(
			'<table><thead><tr><th>Card</th><th>Result</th></tr></thead><tbody><tr><td>I</td><td><strong>Good</strong></td></tr><tr><td>II</td><td>&lt;bad&gt;</td></tr></tbody></table>'
		);
	});

	it('does not treat a "#tag" or hashful sentence as a heading', () => {
		// Needs a space after the hashes and to be a lone line.
		expect(renderMarkdown('Roll 2 hits: success.')).toBe('<p>Roll 2 hits: success.</p>');
	});
});
