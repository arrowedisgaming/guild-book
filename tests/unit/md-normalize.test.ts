import { describe, expect, it } from 'vitest';
import { normalizeMarkdown } from '../../scripts/content-import/md-lib.mjs';
import { renderMarkdown } from '$lib/utils/markdown';

describe('single-column vault layout tables', () => {
	it('normalizes data rows into readable prose instead of a rendered table', () => {
		const body = normalizeMarkdown(
			[
				'Introductory prose.',
				'',
				'| Upkeep |',
				'| --- |',
				'| **Destitute - 0g** |',
				'| First consequence.<br><br>Second consequence. |',
				'| **Common - 50g** |',
				'| Common lodging. |'
			],
			{ preserve: 'full' }
		);

		expect(body).toBe(
			[
				'Introductory prose.',
				'',
				'**Destitute - 0g**',
				'',
				'First consequence.',
				'',
				'Second consequence.',
				'',
				'**Common - 50g**',
				'',
				'Common lodging.'
			].join('\n')
		);
		expect(renderMarkdown(body)).not.toContain('<table>');
		expect(renderMarkdown(body)).toContain('<strong>Destitute - 0g</strong>');
	});

	it('preserves legitimate multi-column tables', () => {
		const source = ['| Card | Result |', '| --- | --- |', '| I | **Good** |'];
		const body = normalizeMarkdown(source, { preserve: 'full' });

		expect(body).toBe(source.join('\n'));
		expect(renderMarkdown(body)).toContain('<table>');
	});
});

describe('external Markdown links', () => {
	it('flattens links to their label — the renderer has no link syntax', () => {
		const body = normalizeMarkdown(
			['Download it at [hismajestytheworm.games](https://www.hismajestytheworm.games/#h.abc).'],
			{ preserve: 'full' }
		);

		expect(body).toBe('Download it at hismajestytheworm.games.');
		expect(renderMarkdown(body)).not.toContain('](');
	});

	it('leaves parenthesized destinations intact so the artifact test catches them', () => {
		const body = normalizeMarkdown(['See [label](https://example.com/a_(b)).'], {
			preserve: 'full'
		});

		expect(body).toBe('See [label](https://example.com/a_(b)).');
	});

	it('keeps emphasis inside a flattened label', () => {
		const body = normalizeMarkdown(
			['See [*hismajestytheworm.games*](https://www.hismajestytheworm.games/) for the sheet.'],
			{ preserve: 'full' }
		);

		expect(body).toBe('See *hismajestytheworm.games* for the sheet.');
		expect(renderMarkdown(body)).toContain('<em>hismajestytheworm.games</em>');
	});
});
