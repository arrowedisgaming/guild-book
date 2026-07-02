import { describe, it, expect } from 'vitest';
import {
	woundOptions,
	applyWound,
	healWoundedTalent,
	canWoundTalent,
	woundedTalentCount,
	MAX_WOUNDED_TALENTS,
	CONDITION_IDS
} from '$lib/engine/wounds';
import { indexItems } from '$lib/engine/encumbrance';
import { getItems } from '$lib/server/content/loader';
import { createBlankCharacter, type GuildBookCharacterData } from '$lib/types/character';

const items = indexItems(getItems());

function adventurer(): GuildBookCharacterData {
	const c = createBlankCharacter();
	c.talents = ['keen-senses', 'aegis', 'reaver'].map((talentId) => ({
		talentId,
		state: 'mastered',
		source: 'path',
		sourceLabel: 'test',
		at: '2026-07-02T00:00:00Z',
		wounded: false,
		xp: 0
	}));
	c.equipment = [
		{
			itemId: 'armor-light',
			customName: null,
			tier: 'common',
			packSpace: 1,
			location: 'worn',
			quantity: 1,
			notchesTaken: 0
		},
		{
			itemId: 'shield-light',
			customName: null,
			tier: 'common',
			packSpace: 1,
			location: 'hand',
			quantity: 1,
			notchesTaken: 0
		}
	];
	return c;
}

describe('woundOptions', () => {
	it('offers notching worn/held protective gear and wounding talents', () => {
		const { options } = woundOptions(adventurer(), items);
		const types = options.map((o) => o.type);
		expect(types).toContain('notch');
		expect(types).toContain('wound-talent');
		expect(options.filter((o) => o.type === 'notch')).toHaveLength(2); // armor + shield
	});

	it('does not offer notching a shield that is stowed in the pack', () => {
		const c = adventurer();
		c.equipment[1].location = 'pack';
		const { options } = woundOptions(c, items);
		expect(options.filter((o) => o.type === 'notch')).toHaveLength(1); // armor only
	});

	it('drops fully-notched gear from the options', () => {
		const c = adventurer();
		c.equipment[0].notchesTaken = 1; // light armor absorbs exactly 1
		const { options } = woundOptions(c, items);
		expect(options.filter((o) => o.type === 'notch')).toHaveLength(1); // shield only
	});

	it('removes talent options entirely at the two-wounded cap', () => {
		const c = adventurer();
		c.talents[0].wounded = true;
		c.talents[1].wounded = true;
		expect(canWoundTalent(c)).toBe(false);
		const { options, hints } = woundOptions(c, items);
		expect(options.some((o) => o.type === 'wound-talent')).toBe(false);
		expect(hints.join(' ')).toMatch(/cap/i);
	});

	it("hints that an Injured adventurer's next wound must be Death's Door", () => {
		const c = adventurer();
		c.conditions = [CONDITION_IDS.injured];
		const { hints } = woundOptions(c, items);
		expect(hints.join(' ')).toMatch(/death's door/i);
	});
});

describe('applyWound / healWoundedTalent', () => {
	it('notches gear', () => {
		const c = adventurer();
		const next = applyWound(c, { type: 'notch', entryIndex: 0, label: '', detail: '' });
		expect(next.equipment[0].notchesTaken).toBe(1);
		expect(c.equipment[0].notchesTaken).toBe(0); // pure — original untouched
	});

	it('wounds a talent and enforces the hard cap', () => {
		let c = adventurer();
		c = applyWound(c, { type: 'wound-talent', talentId: 'keen-senses', label: '', detail: '' });
		c = applyWound(c, { type: 'wound-talent', talentId: 'aegis', label: '', detail: '' });
		expect(woundedTalentCount(c)).toBe(MAX_WOUNDED_TALENTS);
		// Third wound attempt is a no-op.
		const after = applyWound(c, { type: 'wound-talent', talentId: 'reaver', label: '', detail: '' });
		expect(woundedTalentCount(after)).toBe(MAX_WOUNDED_TALENTS);
		expect(after.talents.find((t) => t.talentId === 'reaver')?.wounded).toBe(false);
	});

	it('marks conditions idempotently', () => {
		let c = adventurer();
		const opt = { type: 'condition', conditionId: CONDITION_IDS.staggered, label: '', detail: '' } as const;
		c = applyWound(c, opt);
		c = applyWound(c, opt);
		expect(c.conditions.filter((x) => x === CONDITION_IDS.staggered)).toHaveLength(1);
	});

	it('heals a wounded talent', () => {
		let c = adventurer();
		c = applyWound(c, { type: 'wound-talent', talentId: 'aegis', label: '', detail: '' });
		c = healWoundedTalent(c, 'aegis');
		expect(c.talents.find((t) => t.talentId === 'aegis')?.wounded).toBe(false);
	});
});
