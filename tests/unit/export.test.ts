import { describe, it, expect } from 'vitest';
import { buildDocDefinition } from '$lib/export/pdf-export';
import { exportToMarkdown } from '$lib/export/markdown-export';
import type { CharacterView } from '$lib/types/character-view';

const view: CharacterView = {
	name: 'Grimwald the Bold',
	pronouns: 'he/him',
	appearance: 'Tall and weathered.',
	quest: 'Recover the Well of Lethe.',
	notes: '',
	kith: 'Fay',
	kin: 'Wood Elf',
	path: 'Path of Wands',
	attributes: [
		{ id: 'swords', name: 'Swords', value: 3 },
		{ id: 'pentacles', name: 'Pentacles', value: 2 },
		{ id: 'cups', name: 'Cups', value: 1 },
		{ id: 'wands', name: 'Wands', value: 4 }
	],
	talents: [{ name: 'Cantrip', state: 'mastered' }],
	motifs: ['Disgraced Soldier'],
	bonds: [],
	equipment: [{ name: 'Sword', tier: 'common' }],
	resolve: { current: 4, max: 4 },
	languages: ['Common'],
	conditions: []
};

describe('buildDocDefinition (PDF)', () => {
	it('produces a Letter doc titled with the adventurer name', () => {
		const doc = buildDocDefinition(view);
		expect(doc.pageSize).toBe('LETTER');
		const flat = JSON.stringify(doc.content);
		expect(flat).toContain('Grimwald the Bold');
		expect(flat).toContain('Path of Wands');
	});

	it('always includes the required copyright notice', () => {
		const flat = JSON.stringify(buildDocDefinition(view).content);
		expect(flat).toContain('copyright Joshua McCrowell');
		expect(flat).toContain('not affiliated');
	});
});

describe('exportToMarkdown', () => {
	const md = exportToMarkdown(view);

	it('emits YAML frontmatter with the four attributes', () => {
		expect(md.startsWith('---')).toBe(true);
		expect(md).toMatch(/swords: 3/);
		expect(md).toMatch(/wands: 4/);
		expect(md).toMatch(/system: His Majesty the Worm/);
	});

	it('includes headings and the copyright line', () => {
		expect(md).toContain('# Grimwald the Bold');
		expect(md).toContain('## Attributes');
		expect(md).toContain('copyright Joshua McCrowell');
	});
});
