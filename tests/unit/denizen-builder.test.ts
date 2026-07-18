import { describe, it, expect } from 'vitest';
import {
	createBlankDraft,
	createBlankPoolDraft,
	seedFromTemplates,
	needsReseed,
	toDenizenDefinition,
	draftStatWarnings,
	sanitizeDraft,
	addPool,
	removePool,
	movePool,
	updatePool
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

	it('keeps a pools threat’s pick instructions out of the stat note', () => {
		// "Choose 1 attribute to increase to 6…" is build-time guidance — the
		// Customize step shows it, the finished stat block doesn't carry it.
		const lordDraft = seedFromTemplates(createBlankDraft(), theme('undead'), threat('dungeon-lord'));
		expect(lordDraft.statNote).toBe('');
	});

	it('clears a stale stat note when reseeding', () => {
		const noted = {
			...seedFromTemplates(createBlankDraft(), theme('undead'), threat('brute')),
			statNote: 'Old note'
		};
		const reseeded = seedFromTemplates(noted, theme('undead'), threat('minion'));
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

	it('carries a user-set stat note into the definition', () => {
		const lord = toDenizenDefinition({
			...seedFromTemplates(createBlankDraft(), theme('undead'), threat('dungeon-lord')),
			statNote: 'The crown can only be harmed by silver.'
		});
		expect(lord.statNote).toBe('The crown can only be harmed by silver.');
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

describe('denizen builder — sanitizing persisted drafts', () => {
	it('returns a blank draft for garbage input', () => {
		expect(sanitizeDraft(null)).toEqual(createBlankDraft());
		expect(sanitizeDraft('nonsense')).toEqual(createBlankDraft());
		expect(sanitizeDraft(42)).toEqual(createBlankDraft());
	});

	it('keeps valid fields and repairs invalid ones individually', () => {
		const draft = sanitizeDraft({
			name: 'Locust Husk',
			concept: 123, // wrong type — repaired
			themeId: 'undead',
			threatId: null,
			attributes: { swords: '6', pentacles: 4 }, // 4 is not a string — repaired
			health: '2',
			notes: [
				{ name: 'Tough', text: 'Ignores the first Wound.' },
				{ name: 'Broken' }, // missing text — dropped
				'not an ability' // dropped
			],
			extraneous: 'dropped'
		});
		expect(draft.name).toBe('Locust Husk');
		expect(draft.concept).toBe('');
		expect(draft.themeId).toBe('undead');
		expect(draft.attributes.swords).toBe('6');
		expect(draft.attributes.pentacles).toBe('0');
		expect(draft.health).toBe('2');
		expect(draft.notes).toEqual([{ name: 'Tough', text: 'Ignores the first Wound.' }]);
		expect('extraneous' in draft).toBe(false);
	});

	it('round-trips a real draft unchanged', () => {
		const seeded = seedFromTemplates(
			{ ...createBlankDraft(), name: 'Gilded Horror' },
			theme('undead'),
			threat('brute')
		);
		expect(sanitizeDraft(JSON.parse(JSON.stringify(seeded)))).toEqual(seeded);
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

// --- pools (dungeon lords) ---------------------------------------------------

const seedLord = () => seedFromTemplates(createBlankDraft(), theme('undead'), threat('dungeon-lord'));

const filledPool = (overrides: Partial<ReturnType<typeof createBlankPoolDraft>> = {}) => ({
	...createBlankPoolDraft(),
	name: 'The Crown',
	health: '6',
	defense: '3',
	...overrides
});

describe('denizen builder — pool seeding', () => {
	it('seeds a pools-mode threat with blank top-level HD and one blank pool', () => {
		const draft = seedLord();
		expect(draft.health).toBe('');
		expect(draft.defense).toBe('');
		expect(draft.pools).toEqual([createBlankPoolDraft()]);
	});

	it('seeds standard threats with no pools', () => {
		const draft = seedFromTemplates(createBlankDraft(), theme('undead'), threat('brute'));
		expect(draft.pools).toEqual([]);
	});

	it('clears pools when reseeding from a pools threat to a standard one', () => {
		const lord = updatePool(seedLord(), 0, () => filledPool());
		const reseeded = seedFromTemplates(lord, theme('undead'), threat('brute'));
		expect(reseeded.pools).toEqual([]);
		expect(reseeded.health).toBe('2');
	});
});

describe('denizen builder — pool editing helpers', () => {
	it('adds, updates, and removes pools immutably', () => {
		let draft = seedLord();
		draft = addPool(draft);
		expect(draft.pools).toHaveLength(2);

		draft = updatePool(draft, 1, (p) => ({ ...p, name: 'The Roots' }));
		expect(draft.pools[1].name).toBe('The Roots');
		expect(draft.pools[0].name).toBe('');

		draft = removePool(draft, 0);
		expect(draft.pools).toHaveLength(1);
		expect(draft.pools[0].name).toBe('The Roots');
	});

	it('reorders pools and ignores out-of-range moves', () => {
		let draft = { ...seedLord(), pools: [filledPool({ name: 'A' }), filledPool({ name: 'B' })] };
		draft = movePool(draft, 1, -1);
		expect(draft.pools.map((p) => p.name)).toEqual(['B', 'A']);

		expect(movePool(draft, 0, -1)).toBe(draft); // no-op at the top
		expect(movePool(draft, 1, 1)).toBe(draft); // no-op at the bottom
		expect(movePool(draft, 5, 1)).toBe(draft); // out of range
	});
});

describe('denizen builder — pool stat warnings', () => {
	const lordThreat = threat('dungeon-lord');

	it('accepts a complete dungeon-lord draft', () => {
		const draft = updatePool(seedLord(), 0, () => filledPool());
		expect(draftStatWarnings(draft, lordThreat)).toEqual([]);
	});

	it('requires at least one pool in pools mode', () => {
		const draft = { ...seedLord(), pools: [] };
		expect(draftStatWarnings(draft, lordThreat)).toEqual([
			'This threat is fought in pools — add at least one pool of Health and Defense.'
		]);
	});

	it('requires both Health and Defense on every pool', () => {
		const untouched = seedLord(); // one blank pool
		expect(draftStatWarnings(untouched, lordThreat)).toEqual([
			'Pool 1: every pool needs both Health and Defense.'
		]);

		const half = updatePool(seedLord(), 0, () => filledPool({ name: 'The Crown', defense: '' }));
		expect(draftStatWarnings(half, lordThreat)).toEqual([
			'The Crown: Health and Defense are a pair — fill in both or leave both blank.'
		]);
	});

	it('applies the book stat rules per pool', () => {
		const draft = updatePool(seedLord(), 0, () => filledPool({ health: '0', defense: '-1' }));
		expect(draftStatWarnings(draft, lordThreat)).toEqual([
			'The Crown: starting Health cannot be 0 — use at least 1, or ∞ for the unkillable.',
			'The Crown: Defense cannot be negative (0 is fine).'
		]);
	});

	it('accepts the book edge cases per pool (∞ Health, 0 Defense)', () => {
		const draft = updatePool(seedLord(), 0, () => filledPool({ health: '∞', defense: '0' }));
		expect(draftStatWarnings(draft, lordThreat)).toEqual([]);
	});

	it('flags top-level HD alongside pools as mutually exclusive', () => {
		const draft = { ...updatePool(seedLord(), 0, () => filledPool()), health: '3', defense: '2' };
		expect(draftStatWarnings(draft, lordThreat)).toEqual([
			'Top-level Health/Defense and pools are mutually exclusive — clear the top-level pair.'
		]);
	});

	it('keeps standard-mode behavior unchanged when no threat is passed', () => {
		const draft = { ...createBlankDraft(), health: '4', defense: '' };
		expect(draftStatWarnings(draft)).toEqual([
			'Health and Defense are a pair — fill in both or leave both blank.'
		]);
	});
});

describe('denizen builder — materializing pools', () => {
	it('emits pools with generated ids and omits blank fields', () => {
		const draft = updatePool(seedLord(), 0, () =>
			filledPool({ text: '', lesserDooms: [{ name: 'Crownfall', text: 'The crown shatters.' }] })
		);
		const denizen = toDenizenDefinition(draft);
		expect(denizen.pools).toEqual([
			{
				id: 'custom-pool-1',
				name: 'The Crown',
				health: 6,
				defense: 3,
				lesserDooms: [{ name: 'Crownfall', text: 'The crown shatters.' }]
			}
		]);
		expect('health' in denizen).toBe(false);
	});

	it('keeps special stat values verbatim in pools', () => {
		const draft = updatePool(seedLord(), 0, () => filledPool({ health: '∞', defense: 'X' }));
		expect(toDenizenDefinition(draft).pools?.[0]).toMatchObject({ health: '∞', defense: 'X' });
	});

	it('drops untouched blank pools and omits an empty pools array', () => {
		const denizen = toDenizenDefinition(seedLord()); // one blank pool
		expect('pools' in denizen).toBe(false);
	});

	it('falls back to a placeholder pool name', () => {
		const draft = updatePool(seedLord(), 0, () => filledPool({ name: '' }));
		expect(toDenizenDefinition(draft).pools?.[0].name).toBe('Pool 1');
	});

	it('emits trimmed special rules and omits them when blank', () => {
		const draft = { ...seedLord(), specialRules: '  The lord regrows lost pools at dawn. ' };
		expect(toDenizenDefinition(draft).specialRules).toBe('The lord regrows lost pools at dawn.');
		expect('specialRules' in toDenizenDefinition(seedLord())).toBe(false);
	});
});

describe('denizen builder — sanitizing pool drafts', () => {
	it('repairs garbage pools field by field', () => {
		const draft = sanitizeDraft({
			pools: [
				{ name: 'The Crown', health: 6, defense: '3', notes: 'nope' }, // health wrong type
				'not a pool', // dropped
				null, // dropped
				{ lesserDooms: [{ name: 'Crownfall', text: 'Shatters.' }, { name: 'broken' }] }
			],
			specialRules: 42
		});
		expect(draft.pools).toEqual([
			{ ...createBlankPoolDraft(), name: 'The Crown', defense: '3' },
			{
				...createBlankPoolDraft(),
				lesserDooms: [{ name: 'Crownfall', text: 'Shatters.' }]
			}
		]);
		expect(draft.specialRules).toBe('');
	});

	it('defaults missing pool fields on old drafts without a version bump', () => {
		const draft = sanitizeDraft({ name: 'Old Draft', health: '2', defense: '6' });
		expect(draft.pools).toEqual([]);
		expect(draft.specialRules).toBe('');
	});

	it('round-trips a pooled draft unchanged', () => {
		const seeded = updatePool(seedLord(), 0, () => filledPool());
		expect(sanitizeDraft(JSON.parse(JSON.stringify(seeded)))).toEqual(seeded);
	});
});
