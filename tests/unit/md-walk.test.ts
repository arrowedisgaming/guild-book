import { describe, expect, it } from 'vitest';
import { scanHeadings } from '../../scripts/content-import/md-walk.mjs';

const CH7ish = [
	'# Chapter 7: The Challenge Phase',
	'Intro prose.',
	'# The Flow of the Challenge Phase',
	'## 1. Draw Challenge cards',
	'Player draw text.',
	'### Facedown cards',
	'Facedown text.',
	'# GMing the Challenge',
	'## 1. Draw Challenge cards',
	'GM draw text.'
].join('\n');

describe('scanHeadings', () => {
	it('records level, text, and line for every ATX heading', () => {
		const { headings } = scanHeadings(CH7ish);
		expect(headings.map((h) => [h.level, h.text])).toEqual([
			[1, 'Chapter 7: The Challenge Phase'],
			[1, 'The Flow of the Challenge Phase'],
			[2, '1. Draw Challenge cards'],
			[3, 'Facedown cards'],
			[1, 'GMing the Challenge'],
			[2, '1. Draw Challenge cards']
		]);
	});

	it('builds parent-path locators so duplicated headings are distinct', () => {
		const { headings } = scanHeadings(CH7ish);
		const draws = headings.filter((h) => h.text === '1. Draw Challenge cards');
		expect(draws.map((h) => h.path)).toEqual([
			'The Flow of the Challenge Phase/1. Draw Challenge cards',
			'GMing the Challenge/1. Draw Challenge cards'
		]);
		expect(draws.map((h) => h.occurrence)).toEqual([1, 1]);
	});

	it('numbers occurrences when even the full path repeats', () => {
		const twice = '# A\n## B\ntext\n## B\nmore';
		const { headings } = scanHeadings(twice);
		const bs = headings.filter((h) => h.text === 'B');
		expect(bs.map((h) => h.occurrence)).toEqual([1, 2]);
	});

	it('promotes whole-line bold pseudo-headings to H3, matching md-lib', () => {
		const { headings } = scanHeadings('# A\n**Dwarf arête talent: Iron Beards**\ntext');
		expect(headings[1]).toMatchObject({ level: 3, text: 'Dwarf arête talent: Iron Beards' });
	});
});
