import { describe, it, expect } from 'vitest';
import { sortTalents } from '$lib/engine/talent-order';
import { buildCharacterViewFromContent } from '$lib/character/view';
import { loadWizardData } from '$lib/server/content/loader';
import { createBlankCharacter, type TalentAllocation } from '$lib/types/character';

function talent(
	talentId: string,
	state: TalentAllocation['state'],
	xp = 0,
	source: TalentAllocation['source'] = 'path'
): TalentAllocation {
	return { talentId, state, source, sourceLabel: 'test', at: '2026-07-02T00:00:00Z', wounded: false, xp, preparedUses: 0 };
}

const names: Record<string, string> = { a: 'Zeal', b: 'Acrobat', c: 'Mason', d: 'Brawler', e: 'Yeoman', f: 'Cook', k: 'Night Eyes' };
const nameOf = (id: string) => names[id] ?? id;
const ids = (talents: TalentAllocation[]) => sortTalents(talents, nameOf).map((t) => t.talentId);

describe('sortTalents', () => {
	it('lists mastered, then talents with XP invested, then untrained', () => {
		expect(ids([talent('b', 'in-training', 0), talent('c', 'in-training', 3), talent('a', 'mastered', 7)])).toEqual(['a', 'c', 'b']);
	});

	it('puts the kin talent first among the mastered, the rest by name', () => {
		expect(ids([talent('b', 'mastered'), talent('a', 'mastered'), talent('k', 'mastered', 0, 'kin')])).toEqual(['k', 'b', 'a']);
	});

	it('orders talents in training by name, not by XP invested', () => {
		expect(ids([talent('a', 'in-training', 6), talent('d', 'in-training', 1), talent('c', 'in-training', 2)])).toEqual(['d', 'c', 'a']);
	});

	it('orders untrained talents by name', () => {
		expect(ids([talent('e', 'in-training'), talent('f', 'in-training'), talent('b', 'in-training')])).toEqual(['b', 'f', 'e']);
	});

	it('does not reorder the array it was given', () => {
		const talents = [talent('b', 'in-training'), talent('a', 'mastered')];
		sortTalents(talents, nameOf);
		expect(talents.map((t) => t.talentId)).toEqual(['b', 'a']);
	});
});

describe('buildCharacterViewFromContent', () => {
	it('lists talents in sheet order', () => {
		const char = createBlankCharacter();
		char.talents = [talent('b', 'in-training'), talent('c', 'in-training', 2), talent('a', 'mastered'), talent('k', 'mastered', 0, 'kin')];
		const content = loadWizardData();
		const view = buildCharacterViewFromContent(char, {
			...content,
			talents: Object.entries(names).map(([id, name]) => ({ ...content.talents[0], id, name }))
		});
		expect(view.talents.map((t) => t.name)).toEqual(['Night Eyes', 'Zeal', 'Mason', 'Acrobat']);
	});
});
