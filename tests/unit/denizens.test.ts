import { describe, it, expect } from 'vitest';
import { getDenizenThemes, getDenizenThreats, getBestiary } from '$lib/server/content/loader';
import { denizenDefinitionSchema } from '$lib/schemas/content-pack.schema';

describe('denizens — collections load and validate', () => {
	it('loads without throwing', () => {
		expect(() => getDenizenThemes()).not.toThrow();
		expect(() => getDenizenThreats()).not.toThrow();
		expect(() => getBestiary()).not.toThrow();
	});

	it('has the six themes and five threats from Appendix C', () => {
		expect(getDenizenThemes().map((t) => t.id).sort()).toEqual([
			'beast',
			'elemental',
			'man',
			'sorcerous',
			'spirit',
			'undead'
		]);
		expect(getDenizenThreats().map((t) => t.id).sort()).toEqual([
			'brute',
			'dungeon-lord',
			'elite',
			'minion',
			'strategist'
		]);
	});

	it('has the full bestiary with unique ids', () => {
		const bestiary = getBestiary();
		expect(bestiary).toHaveLength(27);
		expect(new Set(bestiary.map((d) => d.id)).size).toBe(bestiary.length);
	});
});

describe('denizens — referential integrity', () => {
	const themeIds = new Set(getDenizenThemes().map((t) => t.id));
	const threatIds = new Set(getDenizenThreats().map((t) => t.id));

	it('every bestiary entry references a theme and threat that exist', () => {
		for (const denizen of getBestiary()) {
			expect(themeIds.has(denizen.theme), denizen.id).toBe(true);
			expect(threatIds.has(denizen.threat), denizen.id).toBe(true);
		}
	});

	it('every entry has flavor text and either top-level HD or pools', () => {
		for (const denizen of getBestiary()) {
			expect(denizen.flavor.length, denizen.id).toBeGreaterThan(0);
			const hasTopLevelHd = denizen.health !== undefined && denizen.defense !== undefined;
			const hasPools = (denizen.pools?.length ?? 0) > 0;
			expect(hasTopLevelHd || hasPools, denizen.id).toBe(true);
		}
	});

	it('pools always carry their own health and defense', () => {
		for (const denizen of getBestiary()) {
			for (const pool of denizen.pools ?? []) {
				expect(pool.health, `${denizen.id}/${pool.id}`).toBeDefined();
				expect(pool.defense, `${denizen.id}/${pool.id}`).toBeDefined();
			}
		}
	});
});

describe('denizens — book irregularities survive the schema', () => {
	const byId = Object.fromEntries(getBestiary().map((d) => [d.id, d]));

	it('the slime has X attributes explained by a stat note', () => {
		const slime = byId['slime'];
		expect(slime.attributes.swords).toBe('X');
		expect(slime.attributes.pentacles).toBe('X');
		expect(slime.statNote).toMatch(/equal to their current Health/);
	});

	it('the bloodybones has infinite health', () => {
		expect(byId['bloodybones'].health).toBe('∞');
	});

	it('marks pool-based and description-only templates for the builder', () => {
		const threats = Object.fromEntries(getDenizenThreats().map((t) => [t.id, t]));
		expect(threats['dungeon-lord'].builderMode).toBe('pools');
		expect(threats['dungeon-lord'].builderNote).toMatch(/pool editing/);
		for (const id of ['minion', 'brute', 'strategist', 'elite']) {
			expect(threats[id].builderMode, id).toBeUndefined();
		}

		const man = getDenizenThemes().find((t) => t.id === 'man')!;
		expect(man.builderMode).toBe('unsupported');
		expect(man.builderNote).toMatch(/making actual characters/);
	});

	it('encodes no Chapter 7 GM procedure — that belongs in the rules reference', () => {
		// The extra Challenge-card draws for elites/dungeon lords are hand-size
		// procedure from Chapter 7, keyed to the threat type itself; Appendix C
		// data stays purely what the book's denizen appendix states.
		const flat = JSON.stringify(getDenizenThreats());
		expect(flat).not.toMatch(/challengeCard/i);
	});

	it('dungeon lords fight in named pools instead of top-level HD', () => {
		const yellowKing = byId['lich-yellow-king'];
		expect(yellowKing.health).toBeUndefined();
		expect(yellowKing.pools?.map((p) => p.id)).toEqual(['phylactery', 'crown-of-archwood', 'body']);

		const sporehulk = byId['titan-sporehulk'];
		expect(sporehulk.pools?.map((p) => p.id)).toEqual(['legs', 'arms', 'torso']);
		expect(sporehulk.specialRules).toMatch(/rune of protection/i);
	});

	it('sidebars carry the attached extras', () => {
		expect(byId['face-rat'].sidebars?.[0].title).toMatch(/Face Rat Disease/);
		expect(byId['vampire'].sidebars?.map((s) => s.title)).toContain('Killing the Vampire');
	});
});

describe('denizens — stat invariants enforced by the schema', () => {
	const valid = {
		id: 'test-denizen',
		name: 'Test Denizen',
		theme: 'undead',
		threat: 'brute',
		flavor: 'A test.',
		attributes: { swords: 1, pentacles: 1, cups: 1, wands: 1 },
		health: 2,
		defense: 6
	};

	it('accepts a complete stat block, including ∞ Health and 0 Defense', () => {
		expect(denizenDefinitionSchema.safeParse(valid).success).toBe(true);
		expect(
			denizenDefinitionSchema.safeParse({ ...valid, health: '∞', defense: 0 }).success
		).toBe(true);
	});

	it('rejects a starting Health of 0 and blank stat strings', () => {
		expect(denizenDefinitionSchema.safeParse({ ...valid, health: 0 }).success).toBe(false);
		expect(denizenDefinitionSchema.safeParse({ ...valid, health: '' }).success).toBe(false);
		expect(denizenDefinitionSchema.safeParse({ ...valid, defense: ' ' }).success).toBe(false);
		expect(denizenDefinitionSchema.safeParse({ ...valid, defense: -1 }).success).toBe(false);
	});

	it('rejects a half-pair and a denizen with neither HD nor pools', () => {
		const { defense: _defense, ...missingDefense } = valid;
		expect(denizenDefinitionSchema.safeParse(missingDefense).success).toBe(false);

		const { health: _health, defense: _defense2, ...noHd } = valid;
		expect(denizenDefinitionSchema.safeParse(noHd).success).toBe(false);
		expect(
			denizenDefinitionSchema.safeParse({
				...noHd,
				pools: [{ id: 'core', name: 'Core', health: 1, defense: 0 }]
			}).success
		).toBe(true);
	});
});

describe('denizens — transcription spot checks', () => {
	const byId = Object.fromEntries(getBestiary().map((d) => [d.id, d]));

	it('matches the book stat blocks', () => {
		expect(byId['skeleton'].attributes).toEqual({ swords: 6, pentacles: 1, cups: 1, wands: 4 });
		expect(byId['skeleton'].health).toBe(6);
		expect(byId['dragon'].defense).toBe(10);
		expect(byId['zombie'].health).toBe(1);
	});

	it('contains no PLACEHOLDER text anywhere', () => {
		const all = JSON.stringify([getDenizenThemes(), getDenizenThreats(), getBestiary()]);
		expect(all).not.toMatch(/placeholder/i);
	});
});
