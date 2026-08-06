import { describe, expect, it } from 'vitest';
import { tableColumnCells, guardInjectedValue } from '../../scripts/content-import/md-inject.mjs';
import { splitComponent, assembleSpells } from '../../scripts/content-import/md-spells.mjs';

/**
 * Regression coverage for the two importer paths that emit vault text WITHOUT
 * normalizeMarkdown — md-inject's tableColumns cells and md-spells' component
 * paragraph — and therefore don't inherit its image-embed licensing guard.
 * Each case uses a parenthesized path, which the strip regexes deliberately
 * do not recognize, so only the guard stands between the embed and the pack.
 */
const EMBED = '![](images/pageart/foo(bar).png)';

describe('md-inject licensing guard (tableColumns bypass)', () => {
	const TABLE = [
		'| Card | Descriptor | Profession |',
		'| --- | --- | --- |',
		`| I | Stoic | Gravedigger ${EMBED} |`
	];

	it('table cells ship raw — an embed passes extraction untouched', () => {
		expect(tableColumnCells(TABLE, [2])).toEqual([`Gravedigger ${EMBED}`]);
	});

	it('guardInjectedValue fails the build on an embedded cell, naming pack, id, and field', () => {
		expect(() =>
			guardInjectedValue(tableColumnCells(TABLE, [2]), 'motifs.json', { id: 'motifs', field: 'professions' })
		).toThrow(/\[motifs\.json#motifs\.professions\].*foo\(bar\)\.png/);
	});

	it('passes clean cells through unchanged', () => {
		const clean = ['| A | B |', '| --- | --- |', '| Stoic | Gravedigger |'];
		expect(guardInjectedValue(tableColumnCells(clean, [0, 1]), 'motifs.json', { id: 'm', field: 'f' })).toEqual([
			'Stoic',
			'Gravedigger'
		]);
	});
});

describe('md-spells licensing guard (component bypass)', () => {
	const spell = (componentLine: string) => ({
		name: 'Test Spell',
		tradition: 'wastes',
		lines: ['### Component:', '', componentLine, '', 'Effect prose.']
	});

	it('the component paragraph skips normalizeMarkdown — emphasis stripping leaves an embed intact', () => {
		const { component } = splitComponent(spell(`_Burn a moth. ${EMBED}_`).lines);
		expect(component).toContain('![](');
	});

	it('assembleSpells fails the build on a component embed', () => {
		expect(() => assembleSpells([spell(`_Burn a moth. ${EMBED}_`)])).toThrow(/\[spells\.json\].*foo\(bar\)\.png/);
	});

	it('assembles a clean spell, stripping component emphasis', () => {
		const [s] = assembleSpells([spell('_Burn a **rare** moth._')]);
		expect(s.component).toBe('Burn a rare moth.');
		expect(s.id).toBe('test-spell');
		expect(s.description).toBe('Effect prose.');
	});
});
