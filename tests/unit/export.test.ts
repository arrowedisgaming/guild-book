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
	talents: [
		{ name: 'Dwimmercraft', state: 'mastered', wounded: false, xp: 0 },
		{ name: 'Gramarye', state: 'in-training', wounded: true, xp: 3 }
	],
	motifs: ['Disgraced Soldier'],
	bonds: [{ targetName: 'Pib', text: 'Owes me a rescue', charged: true }],
	equipment: [
		{
			name: 'Blade',
			tier: 'impoverished',
			location: 'hand',
			quantity: 1,
			slots: 1,
			notchesTaken: 1,
			durability: 2,
			destroyed: false
		}
	],
	load: {
		hands: { used: 1, capacity: 2, over: false },
		belt: { used: 0, capacity: 4, over: false },
		pack: { used: 0, capacity: 21, over: false }
	},
	conditions: [{ id: 'injured', name: 'Injured', description: 'Next wound is Death\'s Door.' }],
	afflictions: [{ name: 'Ghost Lotus', stage: 2, stageCount: 3, effect: 'No reading or writing.' }],
	resolve: { current: 3, max: 4 },
	lore: 4,
	languages: ['Common']
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

	it('carries play state: wounded talents, conditions, load, bond charge', () => {
		expect(md).toContain('**WOUNDED**');
		expect(md).toContain('**Injured**');
		expect(md).toContain('Ghost Lotus');
		expect(md).toMatch(/hands 1\/2/);
		expect(md).toContain('● **Pib:**');
	});
});

describe('PDF play-state additions', () => {
	it('includes wounded markers, conditions, and load in the doc definition', () => {
		const flat = JSON.stringify(buildDocDefinition(view).content);
		expect(flat).toContain('WOUNDED');
		expect(flat).toContain('Injured');
		expect(flat).toContain('Lore bids 4/4');
		expect(flat).toMatch(/hands 1\/2/);
	});
});
