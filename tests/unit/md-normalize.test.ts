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
