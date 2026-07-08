import { describe, it, expect } from 'vitest';
import { getDenizenThemes, getDenizenThreats, getBestiary } from '$lib/server/content/loader';

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
