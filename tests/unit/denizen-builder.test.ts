import { describe, it, expect } from 'vitest';
import {
	createBlankDraft,
	createBlankPoolDraft,
	seedFromTemplates,
	needsReseed,
	toDenizenDefinition,
	draftStatWarnings,
	draftStatReminders,
	sanitizeDraft,
	addPool,
	removePool,
	movePool,
	updatePool,
	seedPersonFromTheme,
	needsPersonSeed,
	clearPersonState,
	setPersonKith,
	setPersonKin,
	personHasTalent,
	togglePersonTalent,
	setPersonWoundTracking,
	personTracksWounds,
	assignPersonSpreadValue
} from '$lib/engine/denizen-builder';
import { getDenizenThemes, getDenizenThreats, getKiths, getTalents } from '$lib/server/content/loader';

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

	it('seeds the pools stat note but keeps pick instructions out of it', () => {
		// The "Special — …named pools…" text is stat-block content and seeds
		// the note box; "Choose 1 attribute…" lives in chooseAttribute and is
		// Customize guidance only.
		const lordDraft = seedFromTemplates(createBlankDraft(), theme('undead'), threat('dungeon-lord'));
		expect(lordDraft.statNote).toMatch(/named pools of Health and Defense/);
		expect(lordDraft.statNote).not.toMatch(/Choose 1 attribute/);
		expect(threat('dungeon-lord').chooseAttribute).toMatch(/Choose 1 attribute to increase to 6/);
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

	it('rejects fractional stats but leaves special strings alone', () => {
		expect(draftStatWarnings(withStats('3.5', '2'))).toEqual([
			'Health is a whole number — no fractions.'
		]);
		expect(draftStatWarnings(withStats('3', '2.5'))).toEqual([
			'Defense is a whole number — no fractions.'
		]);
		expect(draftStatWarnings(withStats('∞', 'X'))).toEqual([]);
	});

	it('reminds — without blocking — that special strings need a note', () => {
		// ∞ and plain numbers are silent; anything else nudges for a note.
		expect(draftStatReminders(withStats('∞', '0'))).toEqual([]);
		expect(draftStatReminders(withStats('X', '2'))).toEqual([
			`Health is normally a number or ∞ — don't forget a note explaining what "X" means.`
		]);
		expect(draftStatReminders(withStats('3', 'X'))).toEqual([
			`Defense is normally a number or ∞ — don't forget a note explaining what "X" means.`
		]);
		// Reminders are advisory: the hard warnings stay empty.
		expect(draftStatWarnings(withStats('X', '2'))).toEqual([]);
	});

	it('reminds per pool too', () => {
		const draft = {
			...createBlankDraft(),
			pools: [{ ...createBlankPoolDraft(), name: 'The Crown', health: '?', defense: '3' }]
		};
		expect(draftStatReminders(draft)).toEqual([
			`The Crown: Health is normally a number or ∞ — don't forget a note explaining what "?" means.`
		]);
	});

	it("a pool's own Wounds note explains its '*' Health", () => {
		const starPool = { ...createBlankPoolDraft(), name: 'The Crown', health: '*', defense: '3' };
		expect(draftStatReminders({ ...createBlankDraft(), pools: [starPool] })).toEqual([
			`The Crown: Health is normally a number or ∞ — don't forget a note explaining what "*" means.`
		]);
		const explained = { ...starPool, notes: [{ name: 'Wounds', text: 'Track wounds instead.' }] };
		expect(draftStatReminders({ ...createBlankDraft(), pools: [explained] })).toEqual([]);
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

	it('omits both HD stats for a half-filled pool instead of materializing a blank', () => {
		// Health entered, Defense left blank: the pool survives (it is not fully
		// blank) but must not emit defense: '' — omit both, like top-level HD.
		const draft = updatePool(seedLord(), 0, () =>
			filledPool({ name: 'The Crown', health: '6', defense: '' })
		);
		const pool = toDenizenDefinition(draft).pools?.[0];
		expect(pool).toEqual({ id: 'custom-pool-1', name: 'The Crown' });
		expect('health' in pool!).toBe(false);
		expect('defense' in pool!).toBe(false);
	});

	it('numbers surviving pools by their original index, not their post-filter position', () => {
		// A blank pool ahead of a filled one must not renumber the filled pool —
		// its id/name stay in step with the Pools-step UI (unfiltered index).
		const draft = {
			...seedLord(),
			pools: [createBlankPoolDraft(), filledPool({ name: '' })]
		};
		const pool = toDenizenDefinition(draft).pools?.[0];
		expect(pool).toMatchObject({ id: 'custom-pool-2', name: 'Pool 2' });
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

// --- people (the Man theme's adversary path) ---------------------------------

const manTheme = () => theme('man');
const seedPerson = () => seedPersonFromTheme(createBlankDraft(), manTheme());
const kiths = getKiths();

describe('denizen builder — person seeding', () => {
	it('seeds the adventurer spread, simple default HD, and no threat', () => {
		const draft = seedPerson();
		expect(draft.kind).toBe('person');
		expect(draft.threatId).toBeNull();
		expect(draft.attributes).toEqual({ swords: '4', pentacles: '3', cups: '2', wands: '1' });
		// HD pre-filled for simplicity; the Customize step explains it — the
		// stat block itself carries no boilerplate note.
		expect(draft.health).toBe('5');
		expect(draft.defense).toBe('1');
		expect(draft.statNote).toBe('');
		expect(draft.pools).toEqual([]);
	});

	it('preserves identity fields across a person seed', () => {
		const blank = { ...createBlankDraft(), name: 'Odo the Cannibal', concept: 'A hermit' };
		const draft = seedPersonFromTheme(blank, manTheme());
		expect(draft.name).toBe('Odo the Cannibal');
		expect(draft.concept).toBe('A hermit');
	});

	it('knows when a person seed is needed', () => {
		expect(needsPersonSeed(createBlankDraft(), manTheme())).toBe(true); // creature kind
		const seeded = seedPerson();
		expect(needsPersonSeed(seeded, manTheme())).toBe(false);
	});

	it('clears person-only state when leaving the person path', () => {
		const person = setPersonKith(seedPerson(), kiths[0]);
		const cleared = clearPersonState(person);
		expect(cleared.kind).toBe('creature');
		expect(cleared.kithId).toBeNull();
		expect(cleared.statNote).toBe('');
		expect(cleared.notes.some((n) => n.name.startsWith('Kith:'))).toBe(false);
	});
});

describe('denizen builder — person kith and spread', () => {
	it('keeps a single kith note in sync with the chosen kith', () => {
		let draft = setPersonKith(seedPerson(), kiths[0]);
		expect(draft.kithId).toBe(kiths[0].id);
		expect(draft.notes.filter((n) => n.name.startsWith('Kith:'))).toHaveLength(1);
		expect(draft.notes[0].name).toBe(`Kith: ${kiths[0].name}`);

		draft = setPersonKith(draft, kiths[1]);
		expect(draft.notes.filter((n) => n.name.startsWith('Kith:'))).toHaveLength(1);
		expect(draft.notes[0].name).toBe(`Kith: ${kiths[1].name}`);

		draft = setPersonKith(draft, null);
		expect(draft.kithId).toBeNull();
		expect(draft.notes.some((n) => n.name.startsWith('Kith:'))).toBe(false);
	});

	it('assigns a spread value by swapping with its current holder', () => {
		// Seeded: swords 4, pentacles 3, cups 2, wands 1. Give cups the 4.
		const draft = assignPersonSpreadValue(seedPerson(), 'cups', 4);
		expect(draft.attributes).toEqual({ swords: '2', pentacles: '3', cups: '4', wands: '1' });
		// Still a valid spread, so no warning.
		expect(draftStatWarnings(draft)).toEqual([]);
	});

	it('warns when the attributes are not the adventurer spread', () => {
		const draft = { ...seedPerson(), attributes: { swords: '4', pentacles: '4', cups: '2', wands: '1' } };
		expect(draftStatWarnings(draft)).toEqual([
			'A person uses the adventurer spread — assign 4, 3, 2, and 1 each to one suit.'
		]);
	});

	it('applies the HD pair rule to people who are given stats', () => {
		const draft = { ...seedPerson(), defense: '' };
		expect(draftStatWarnings(draft)).toEqual([
			'Health and Defense are a pair — fill in both or leave both blank.'
		]);
	});
});

describe('denizen builder — materializing a person', () => {
	it('omits the threat key and carries no boilerplate stat note', () => {
		const denizen = toDenizenDefinition({ ...seedPerson(), name: 'Odo' });
		expect(denizen.theme).toBe('man');
		expect('threat' in denizen).toBe(false);
		expect('statNote' in denizen).toBe(false);
		// Simple default HD carries through.
		expect(denizen.health).toBe(5);
		expect(denizen.defense).toBe(1);
	});

	it('carries the kith note into the definition', () => {
		const denizen = toDenizenDefinition(setPersonKith(seedPerson(), kiths[0]));
		expect(denizen.notes?.[0].name).toBe(`Kith: ${kiths[0].name}`);
	});
});

describe('denizen builder — person wound tracking', () => {
	it('toggles the Wounds note and a * Health', () => {
		const tracking = setPersonWoundTracking(seedPerson(), true);
		expect(personTracksWounds(tracking)).toBe(true);
		expect(tracking.health).toBe('*');
		const note = tracking.notes.find((n) => n.name === 'Wounds')!;
		expect(note.text).toMatch(/notch a piece of armor/i);
		expect(note.text).toMatch(/Death's Door/);
		expect(note.text).toMatch(/- \[ \] notch a piece of armor/); // rendered as a checklist

		const off = setPersonWoundTracking(tracking, false);
		expect(personTracksWounds(off)).toBe(false);
		expect(off.health).toBe('5'); // the * restores to the simple default
	});

	it('never doubles the Wounds note and keeps a custom Health on toggle-off', () => {
		let draft = setPersonWoundTracking(seedPerson(), true);
		draft = setPersonWoundTracking(draft, true);
		expect(draft.notes.filter((n) => n.name === 'Wounds')).toHaveLength(1);

		draft = { ...draft, health: '8' }; // user overrode the * by hand
		draft = setPersonWoundTracking(draft, false);
		expect(draft.health).toBe('8');
		expect(personTracksWounds(draft)).toBe(false);
	});

	it('restores a pre-toggle custom Health, not the default', () => {
		// User set Health 7, tried wound tracking, changed their mind.
		let draft = { ...seedPerson(), health: '7' };
		draft = setPersonWoundTracking(draft, true);
		expect(draft.health).toBe('*');
		draft = setPersonWoundTracking(draft, false);
		expect(draft.health).toBe('7');
		expect(draft.healthBeforeWounds).toBe('');
	});

	it('kin selection keeps a single arete-talent note in sync', () => {
		const kith = kiths[0];
		const kin = kith.kins.find((k) => k.areteTalentId)!;
		const arete = getTalents().find((t) => t.id === kin.areteTalentId)!;

		let draft = setPersonKith(seedPerson(), kith);
		draft = setPersonKin(draft, kin, arete);
		expect(draft.kinId).toBe(kin.id);
		expect(draft.notes.filter((n) => n.name.startsWith('Arete talent:'))).toHaveLength(1);
		expect(draft.notes.some((n) => n.name === `Arete talent: ${arete.name}`)).toBe(true);

		// Clearing the kin removes the note; changing kith clears kin too.
		expect(setPersonKin(draft, null, null).notes.some((n) => n.name.startsWith('Arete'))).toBe(false);
		const rekithed = setPersonKith(draft, kiths[1]);
		expect(rekithed.kinId).toBeNull();
		expect(rekithed.notes.some((n) => n.name.startsWith('Arete'))).toBe(false);
	});

	it('talents toggle on and off as notes', () => {
		const talent = getTalents()[0];
		let draft = togglePersonTalent(seedPerson(), talent, true);
		expect(personHasTalent(draft, talent)).toBe(true);
		expect(draft.notes.some((n) => n.name === `Talent: ${talent.name}`)).toBe(true);

		draft = togglePersonTalent(draft, talent, true); // no doubling
		expect(draft.notes.filter((n) => n.name === `Talent: ${talent.name}`)).toHaveLength(1);

		draft = togglePersonTalent(draft, talent, false);
		expect(personHasTalent(draft, talent)).toBe(false);
	});

	it('a wound-tracking person still materializes and passes stat warnings', () => {
		const draft = setPersonWoundTracking(seedPerson(), true);
		expect(draftStatWarnings(draft)).toEqual([]);
		const denizen = toDenizenDefinition(draft);
		expect(denizen.health).toBe('*');
		expect(denizen.notes?.some((n) => n.name === 'Wounds')).toBe(true);
	});

	it('the Wounds note renders drawn checkboxes in HTML and PDF', async () => {
		const { renderMarkdown } = await import('$lib/utils/markdown');
		const { buildDenizenDocDefinition } = await import('$lib/export/denizen-pdf-export');
		const draft = setPersonWoundTracking(seedPerson(), true);
		const note = draft.notes.find((n) => n.name === 'Wounds')!;

		const html = renderMarkdown(note.text);
		expect(html).toContain('<li class="task"><input type="checkbox" disabled />');
		// The two talent wounds are separate lines — Obsidian and other GFM
		// renderers only honour one checkbox per list item.
		expect(html).toContain('disabled /> Wound a talent (two max)');
		expect(html).toContain('disabled /> Wound a second talent');

		const doc = buildDenizenDocDefinition(toDenizenDefinition(draft), 'Man', '');
		const flattened = JSON.stringify(doc);
		expect(flattened).toContain('"type":"rect"'); // vector-drawn boxes
		expect(flattened).not.toContain('[ ]'); // no literal bracket boxes remain
	});
});

describe('denizen builder — sanitizing person drafts', () => {
	it('defaults kind and kith on old drafts', () => {
		const draft = sanitizeDraft({ name: 'Old Draft' });
		expect(draft.kind).toBe('creature');
		expect(draft.kithId).toBeNull();
	});

	it('repairs a garbage kind to creature', () => {
		expect(sanitizeDraft({ kind: 'werewolf' }).kind).toBe('creature');
		expect(sanitizeDraft({ kind: 'person' }).kind).toBe('person');
	});

	it('round-trips a person draft unchanged', () => {
		const person = setPersonKith(seedPerson(), kiths[2]);
		expect(sanitizeDraft(JSON.parse(JSON.stringify(person)))).toEqual(person);
	});
});
