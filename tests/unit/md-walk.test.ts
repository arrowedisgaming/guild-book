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

import { walkChapter } from '../../scripts/content-import/md-walk.mjs';

const OWNERSHIP = [
	'# Chapter 2: The Adventurer',
	'Chapter intro paragraph.',
	'# Session 0',
	'H1 intro prose.',
	'## 2. Attributes',
	'Attributes prose.',
	'### Details',
	'Detail prose stays inline.',
	'## 3. Quests',
	'Quests prose.',
	'# Pure Container',
	'## Only Child',
	'Child prose.'
].join('\n');

describe('walkChapter ownership', () => {
	it('assigns every source paragraph to exactly one candidate body', () => {
		const { candidates } = walkChapter(OWNERSHIP, {});
		const bodies = candidates.map((c) => c.bodyLines.join('\n'));
		for (const paragraph of [
			'Chapter intro paragraph.',
			'H1 intro prose.',
			'Attributes prose.',
			'Detail prose stays inline.',
			'Quests prose.',
			'Child prose.'
		]) {
			expect(bodies.filter((b) => b.includes(paragraph))).toHaveLength(1);
		}
	});

	it('gives an H1 only its pre-H2 prose, and keeps H3 inline in its H2', () => {
		const { candidates } = walkChapter(OWNERSHIP, {});
		const session0 = candidates.find((c) => c.text === 'Session 0');
		expect(session0?.bodyLines.join('\n')).toBe('H1 intro prose.');
		const attrs = candidates.find((c) => c.text === '2. Attributes');
		expect(attrs?.bodyLines.join('\n')).toContain('### Details');
		expect(attrs?.bodyLines.join('\n')).toContain('Detail prose stays inline.');
	});

	it('records a prose-less H1 as a container, not a candidate', () => {
		const { candidates, ledger } = walkChapter(OWNERSHIP, {});
		expect(candidates.find((c) => c.text === 'Pure Container')).toBeUndefined();
		expect(ledger.find((r) => r.locator === 'Pure Container')).toMatchObject({
			disposition: 'container'
		});
	});

	it('splitDeeper lifts an H3 out of its H2 into its own candidate', () => {
		const md = ['# Flow', '## 3. Take turns', 'Turn prose.', '### Action value', 'Value prose.'].join('\n');
		const { candidates } = walkChapter(md, {
			splitDeeper: [{ at: 'Flow/3. Take turns/Action value', id: 'x-action-value' }]
		});
		const turns = candidates.find((c) => c.text === '3. Take turns');
		const value = candidates.find((c) => c.text === 'Action value');
		expect(turns?.bodyLines.join('\n')).toBe('Turn prose.');
		expect(value?.bodyLines.join('\n')).toBe('Value prose.');
	});

	it('skip excludes the heading and its whole subtree, with the reason ledgered', () => {
		const md = ['# Keep', 'kept.', '## NEW ADVENTURER CHECKLIST', 'dupe.', '### Sub', 'sub dupe.', '## After', 'after.'].join('\n');
		const { candidates, ledger } = walkChapter(md, {
			skip: [{ at: 'Keep/NEW ADVENTURER CHECKLIST', reason: 'duplicate all-caps copy of the checklist' }]
		});
		expect(candidates.map((c) => c.text)).toEqual(['Keep', 'After']);
		expect(ledger.find((r) => r.disposition === 'skipped')).toMatchObject({
			locator: 'Keep/NEW ADVENTURER CHECKLIST',
			reason: 'duplicate all-caps copy of the checklist'
		});
	});

	it('throws on a skip/splitDeeper locator that matches nothing', () => {
		expect(() => walkChapter(OWNERSHIP, { skip: [{ at: 'Nope/Missing', reason: 'x' }] })).toThrow(/locator/i);
	});
});

import { cleanTitle, defaultSlug, resolveEntries } from '../../scripts/content-import/md-walk.mjs';

describe('id and title normalization', () => {
	it('strips ordinal junk and chapter prefixes', () => {
		expect(defaultSlug('8 - Conditions')).toBe('conditions');
		expect(defaultSlug('9 -Resolve')).toBe('resolve');
		expect(defaultSlug('1. Draw Challenge cards')).toBe('draw-challenge-cards');
		expect(defaultSlug('Chapter 2: The Adventurer')).toBe('the-adventurer');
		expect(defaultSlug("We're doomed!")).toBe('were-doomed');
		expect(cleanTitle('8 - Conditions')).toBe('Conditions');
		expect(cleanTitle('Chapter 2: The Adventurer')).toBe('The Adventurer');
	});
});

describe('resolveEntries', () => {
	const cand = (locator: string, text: string, occurrence = 1) => ({
		locator, occurrence, level: 2, text, bodyLines: ['x']
	});

	it('prefixes ids with the section', () => {
		const out = resolveEntries([cand('A/Watches', 'Watches')], { section: 'crawl-phase' });
		expect(out[0]).toMatchObject({ id: 'crawl-phase-watches', title: 'Watches' });
	});

	it('applies explicit ids and aliases by locator', () => {
		const out = resolveEntries(
			[cand('Flow/1. Draw Challenge cards', '1. Draw Challenge cards'), cand('GMing/1. Draw Challenge cards', '1. Draw Challenge cards')],
			{
				section: 'challenge-phase',
				idAliases: { 'Flow/1. Draw Challenge cards': 'challenge-draw-cards' },
				ids: { 'GMing/1. Draw Challenge cards': 'challenge-gm-hand-size' }
			}
		);
		expect(out.map((e) => e.id)).toEqual(['challenge-draw-cards', 'challenge-gm-hand-size']);
	});

	it('throws on an unresolved id collision, naming both locators', () => {
		expect(() =>
			resolveEntries(
				[cand('Flow/1. Draw Challenge cards', '1. Draw Challenge cards'), cand('GMing/1. Draw Challenge cards', '1. Draw Challenge cards')],
				{ section: 'challenge-phase' }
			)
		).toThrow(/Flow\/1\. Draw Challenge cards[\s\S]*GMing\/1\. Draw Challenge cards/);
	});

	it('throws when two locators claim the same alias (bijectivity)', () => {
		expect(() =>
			resolveEntries([cand('A/X', 'X'), cand('A/Y', 'Y')], {
				section: 's',
				idAliases: { 'A/X': 'legacy-id', 'A/Y': 'legacy-id' }
			})
		).toThrow(/alias/i);
	});

	it('throws when an ids/idAliases locator matches no candidate', () => {
		expect(() =>
			resolveEntries([cand('A/X', 'X')], { section: 's', ids: { 'A/Zed': 'nope' } })
		).toThrow(/locator/i);
	});
});
