import { describe, it, expect } from 'vitest';
import {
	createBlankDraft,
	seedFromTemplates,
	needsReseed,
	toDenizenDefinition,
	draftStatWarnings
} from '$lib/engine/denizen-builder';
import { getDenizenThemes, getDenizenThreats } from '$lib/server/content/loader';

const themes = getDenizenThemes();
const threats = getDenizenThreats();
const theme = (id: string) => themes.find((t) => t.id === id)!;
const threat = (id: string) => threats.find((t) => t.id === id)!;

describe('denizen builder — template seeding', () => {
	it('seeds attributes and HD from the threat, likes/hates from the theme', () => {
		const draft = seedFromTemplates(createBlankDraft(), theme('undead'), threat('brute'));
		expect(draft.attributes).toEqual({ swords: '6', pentacles: '4', cups: '1', wands: '1' });
		expect(draft.health).toBe('2');
		expect(draft.defense).toBe('6');
		expect(draft.likes).toBe('Some Fond Memory of Life');
		expect(draft.hates).toBe('The Living');
	});

	it('concatenates standing notes from both templates', () => {
		const draft = seedFromTemplates(createBlankDraft(), theme('undead'), threat('brute'));
		const names = draft.notes.map((n) => n.name);
		expect(names).toContain('Breathless and Undreaming'); // theme
		expect(names).toContain('Tough'); // threat
	});

	it('does not seed dooms — templates are pick-lists', () => {
		const draft = seedFromTemplates(createBlankDraft(), theme('beast'), threat('elite'));
		expect(draft.lesserDooms).toEqual([]);
		expect(draft.greaterDooms).toEqual([]);
	});

	it('survives templates without stat blocks (man, dungeon lord)', () => {
		const draft = seedFromTemplates(createBlankDraft(), theme('man'), threat('dungeon-lord'));
		expect(draft.likes).toBe('');
		expect(draft.health).toBe('');
		expect(draft.attributes.swords).toBe('3');
	});

	it('seeds the threat stat note', () => {
		const lordDraft = seedFromTemplates(createBlankDraft(), theme('undead'), threat('dungeon-lord'));
		expect(lordDraft.statNote).toMatch(/Choose 1 attribute to increase to 6/);
	});

	it('clears the stat note when reseeding to a threat without one', () => {
		const lord = seedFromTemplates(createBlankDraft(), theme('undead'), threat('dungeon-lord'));
		const reseeded = seedFromTemplates(lord, theme('undead'), threat('minion'));
		expect(reseeded.statNote).toBe('');
	});

	it('preserves identity fields across a seed', () => {
		const blank = { ...createBlankDraft(), name: 'Locust Husk', exaggeration: 'locusts' };
		const draft = seedFromTemplates(blank, theme('undead'), threat('minion'));
		expect(draft.name).toBe('Locust Husk');
		expect(draft.exaggeration).toBe('locusts');
	});
});

describe('denizen builder — reseed detection', () => {
	it('wants a reseed only when the chosen pair differs from the seeded pair', () => {
		const blank = createBlankDraft();
		expect(needsReseed(blank)).toBe(false); // nothing chosen yet

		const seeded = seedFromTemplates(blank, theme('undead'), threat('brute'));
		expect(needsReseed(seeded)).toBe(false);

		expect(needsReseed({ ...seeded, threatId: 'minion' })).toBe(true);
	});
});

describe('denizen builder — materializing a definition', () => {
	it('normalizes numeric strings and keeps special values verbatim', () => {
		const draft = {
			...seedFromTemplates(createBlankDraft(), theme('sorcerous'), threat('elite')),
			name: '  Gilded Slime ',
			health: '∞',
			attributes: { swords: 'X', pentacles: '4', cups: '0', wands: '0' }
		};
		const denizen = toDenizenDefinition(draft);
		expect(denizen.name).toBe('Gilded Slime');
		expect(denizen.health).toBe('∞');
		expect(denizen.attributes.swords).toBe('X');
		expect(denizen.attributes.pentacles).toBe(4);
	});

	it('composes flavor from concept + exaggeration when no description is given', () => {
		const draft = {
			...createBlankDraft(),
			concept: 'A zombie',
			exaggeration: "it's animated by a swarm of locusts"
		};
		expect(toDenizenDefinition(draft).flavor).toBe(
			"A zombie — but it's animated by a swarm of locusts."
		);
	});

	it('splits comma-separated likes and hates', () => {
		const draft = { ...createBlankDraft(), likes: 'Fire, Gold,  , Royalty ' };
		expect(toDenizenDefinition(draft).likes).toEqual(['Fire', 'Gold', 'Royalty']);
	});

	it('falls back to a placeholder name', () => {
		expect(toDenizenDefinition(createBlankDraft()).name).toBe('Unnamed Denizen');
	});

	it('carries the stat note into the definition', () => {
		const lord = toDenizenDefinition(
			seedFromTemplates(createBlankDraft(), theme('undead'), threat('dungeon-lord'))
		);
		expect(lord.statNote).toMatch(/Choose 1 attribute to increase to 6/);
	});

	it('omits the stat note when the threat has none', () => {
		const denizen = toDenizenDefinition(
			seedFromTemplates(createBlankDraft(), theme('undead'), threat('minion'))
		);
		expect('statNote' in denizen).toBe(false);
	});

	it('omits blank Health/Defense instead of materializing empty strings', () => {
		const lord = toDenizenDefinition(
			seedFromTemplates(createBlankDraft(), theme('undead'), threat('dungeon-lord'))
		);
		expect('health' in lord).toBe(false);
		expect('defense' in lord).toBe(false);
	});
});

describe('denizen builder — stat warnings', () => {
	const withStats = (health: string, defense: string) => ({
		...createBlankDraft(),
		health,
		defense
	});

	it('accepts the book’s edge cases: ∞ Health and 0 Defense', () => {
		expect(draftStatWarnings(withStats('∞', '0'))).toEqual([]);
	});

	it('accepts both stats blank (pool-based or unfinished drafts)', () => {
		expect(draftStatWarnings(withStats('', ''))).toEqual([]);
	});

	it('rejects a starting Health of 0', () => {
		expect(draftStatWarnings(withStats('0', '3'))).toEqual([
			'Starting Health cannot be 0 — use at least 1, or ∞ for the unkillable.'
		]);
	});

	it('rejects negative Defense', () => {
		expect(draftStatWarnings(withStats('4', '-1'))).toEqual([
			'Defense cannot be negative (0 is fine).'
		]);
	});

	it('flags a half-filled Health/Defense pair', () => {
		expect(draftStatWarnings(withStats('4', ''))).toEqual([
			'Health and Defense are a pair — fill in both or leave both blank.'
		]);
	});
});
