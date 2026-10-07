import { describe, expect, it } from 'vitest';
import { applyXpAction, validateExperience, validateExperienceChange, validateExperienceTransition, type ExperienceContent } from '$lib/engine/experience';
import { createBlankCharacter, type GuildBookCharacterData } from '$lib/types/character';

const content: ExperienceContent = {
	advancement: {
		masteryXp: 7, pathUseXp: 1, cityTrainingGoldPerXp: 50,
		awards: [
			{ id: 'quest', label: 'Quest accepted', amount: 3, ruleEntryId: 'xp', reminder: 'r' },
			{ id: 'other', label: 'Table award', amount: null, ruleEntryId: 'xp', reminder: 'r' }
		]
	},
	paths: [
		{ id: 'ours', name: 'Our path', suit: 'swords', description: '', talentIds: ['own'] },
		{ id: 'theirs', name: 'Their path', suit: 'cups', description: '', talentIds: ['other'] }
	],
	talents: [
		{ id: 'own', name: 'Own Talent', description: '', source: 'path' },
		{ id: 'other', name: 'Other Talent', description: '', source: 'path' },
		{ id: 'kin', name: 'Kin Talent', description: '', source: 'kin' }
	]
};

function character(balance = 0): GuildBookCharacterData {
	const c = createBlankCharacter();
	c.pathId = 'ours';
	c.experience = balance;
	c.xpLedger.openingBalance = balance;
	c.talents = [
		{ talentId: 'own', state: 'in-training', source: 'path', sourceLabel: 'Our path', at: '', wounded: false, xp: 0, preparedUses: 0 },
		{ talentId: 'other', state: 'in-training', source: 'general', sourceLabel: 'Mentor', at: '', wounded: false, xp: 0, preparedUses: 0 }
	];
	return c;
}

const ctx = { id: 'entry-1', at: '2026-09-09T12:00:00.000Z', reason: 'A concrete reason' };
const success = (result: ReturnType<typeof applyXpAction>) => {
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.error);
	return result.character;
};

describe('applyXpAction', () => {
	it('awards a configured preset without mutating the input', () => {
		const input = character();
		const result = success(applyXpAction(input, { kind: 'award', presetId: 'quest' }, ctx, content));
		expect(result.experience).toBe(3);
		expect(result.xpLedger.entries[0]).toMatchObject({ delta: 3, kind: 'award', sourceId: 'quest', sourceLabel: 'Quest accepted' });
		expect(input.experience).toBe(0);
	});

	it('spends XP and advances an own-path talent atomically', () => {
		const result = success(applyXpAction(character(3), { kind: 'talent-use', talentId: 'own' }, ctx, content));
		expect(result.experience).toBe(2);
		expect(result.talents[0]).toMatchObject({ xp: 1, state: 'in-training' });
	});

	it('masters at the configured threshold and a mastered use costs nothing', () => {
		const input = character(1);
		input.talents[0].xp = 6;
		const mastered = success(applyXpAction(input, { kind: 'talent-use', talentId: 'own' }, ctx, content));
		expect(mastered.talents[0]).toMatchObject({ xp: 7, state: 'mastered' });
		const reused = success(applyXpAction(mastered, { kind: 'talent-use', talentId: 'own' }, { ...ctx, id: 'entry-2' }, content));
		expect(reused).toEqual(mastered);
	});

	it('rejects insufficient balance, wounds, reused IDs, and unknown or duplicate talents', () => {
		expect(applyXpAction(character(), { kind: 'talent-use', talentId: 'own' }, ctx, content).ok).toBe(false);
		const wounded = character(1); wounded.talents[0].wounded = true;
		expect(applyXpAction(wounded, { kind: 'talent-use', talentId: 'own' }, ctx, content).ok).toBe(false);
		const duplicate = character(1); duplicate.talents.push({ ...duplicate.talents[0] });
		expect(applyXpAction(duplicate, { kind: 'talent-use', talentId: 'own' }, ctx, content).ok).toBe(false);
		expect(applyXpAction(character(1), { kind: 'talent-use', talentId: 'missing' }, ctx, content).ok).toBe(false);
		const used = success(applyXpAction(character(), { kind: 'award', presetId: 'quest' }, ctx, content));
		expect(applyXpAction(used, { kind: 'spend', amount: 1 }, ctx, content).ok).toBe(false);
	});

	it('mentors cross-path talents and consumes prepared uses without spending XP', () => {
		const trained = success(applyXpAction(character(4), { kind: 'mentoring', talentId: 'other', amount: 2, mentor: 'Mara', phase: 'city' }, ctx, content));
		expect(trained.experience).toBe(2);
		expect(trained.talents[1]).toMatchObject({ xp: 2, preparedUses: 2 });
		const used = success(applyXpAction(trained, { kind: 'prepared-use', talentId: 'other' }, { ...ctx, id: 'unused-for-ledger' }, content));
		expect(used.experience).toBe(2);
		expect(used.talents[1]).toMatchObject({ xp: 2, preparedUses: 1 });
		expect(used.xpLedger.entries).toHaveLength(1);
	});

	it('rejects mentoring own/foreign talents, unknown prepared counts, and over-investment', () => {
		expect(applyXpAction(character(2), { kind: 'mentoring', talentId: 'own', amount: 1, mentor: 'M', phase: 'camp' }, ctx, content).ok).toBe(false);
		const foreign = character(2); foreign.talents.push({ talentId: 'kin', state: 'in-training', source: 'kin', sourceLabel: 'Kin', at: '', wounded: false, xp: 0, preparedUses: 0 });
		expect(applyXpAction(foreign, { kind: 'mentoring', talentId: 'kin', amount: 1, mentor: 'M', phase: 'camp' }, ctx, content).ok).toBe(false);
		const legacy = character(2); legacy.talents[1].preparedUses = null;
		expect(applyXpAction(legacy, { kind: 'prepared-use', talentId: 'other' }, ctx, content).ok).toBe(false);
		const nearly = character(3); nearly.talents[1].xp = 6;
		expect(applyXpAction(nearly, { kind: 'mentoring', talentId: 'other', amount: 2, mentor: 'M', phase: 'camp' }, ctx, content).ok).toBe(false);
	});

	it('rejects prepared-use bypasses and wounded mastered use', () => {
		const own = character(0); own.talents[0].preparedUses = 1;
		expect(applyXpAction(own, { kind: 'prepared-use', talentId: 'own' }, ctx, content).ok).toBe(false);
		const foreign = character(0); foreign.talents.push({ talentId: 'kin', state: 'in-training', source: 'kin', sourceLabel: 'Kin', at: '', wounded: false, xp: 0, preparedUses: 1 });
		expect(applyXpAction(foreign, { kind: 'prepared-use', talentId: 'kin' }, ctx, content).ok).toBe(false);
		const wounded = character(0); Object.assign(wounded.talents[0], { state: 'mastered', xp: 7, wounded: true });
		expect(applyXpAction(wounded, { kind: 'talent-use', talentId: 'own' }, ctx, content).ok).toBe(false);
	});

	it('rejects unsafe integers that can corrupt ledger arithmetic', () => {
		const input = character(Number.MAX_SAFE_INTEGER + 1);
		expect(validateExperience(input).join(' ')).toMatch(/safe/i);
		expect(applyXpAction(input, { kind: 'award', presetId: 'quest' }, ctx, content).ok).toBe(false);
	});

	it('records unrelated spending without changing talents', () => {
		const input = character(4);
		const result = success(applyXpAction(input, { kind: 'spend', amount: 2 }, { ...ctx, reason: 'Assemble a goblin horde' }, content));
		expect(result.experience).toBe(2);
		expect(result.talents).toEqual(input.talents);
		expect(result.xpLedger.entries[0]).toMatchObject({ delta: -2, kind: 'spend' });
	});

	it('repairs fractional legacy balance explicitly without rewriting opening history', () => {
		const input = character(-0.5);
		const result = success(applyXpAction(input, { kind: 'correction', balanceDelta: 1.5 }, ctx, content));
		expect(result.experience).toBe(1);
		expect(result.xpLedger.openingBalance).toBe(-0.5);
		expect(validateExperience(result)).toEqual([]);
	});

	it('records talent corrections with snapshots and a durable talent label', () => {
		const input = character(0);
		input.talents[1].preparedUses = null;
		const result = success(applyXpAction(input, { kind: 'correction', balanceDelta: 0, talent: { talentId: 'other', xp: 0, state: 'in-training', preparedUses: 2 } }, ctx, content));
		expect(result.xpLedger.entries[0]).toMatchObject({ sourceLabel: 'Correction — Other Talent', talentBefore: { preparedUses: null }, talentAfter: { preparedUses: 2 } });
	});

	it('validates malformed ledger fields and talent counters', () => {
		const c = character(0);
		c.xpLedger.openingBalance = Number.NaN;
		c.talents[0].xp = -1;
		c.talents[1].preparedUses = -1;
		c.xpLedger.entries = [
			{ id: '', at: 'bad', delta: 0, kind: 'award', sourceId: 'x', sourceLabel: '', reason: '', sessionLabel: '', talentId: 'own' },
			{ id: 'dup', at: ctx.at, delta: 0, kind: 'spend', sourceId: 'x', sourceLabel: 'x'.repeat(201), reason: 'x'.repeat(1001) },
			{ id: 'dup', at: ctx.at, delta: Number.POSITIVE_INFINITY, kind: 'correction', sourceId: 'x', sourceLabel: 'x', reason: 'x' },
			{ id: 'repair', at: ctx.at, delta: 0, kind: 'correction', sourceId: 'x', sourceLabel: 'x', reason: 'x' }
		];
		const errors = validateExperience(c).join(' ');
		for (const phrase of ['opening balance', 'nonempty', 'Duplicate', 'timestamp', 'reason', 'source label', 'session label', 'award', 'spend', 'correction', 'Talent own XP', 'prepared uses']) expect(errors).toContain(phrase);
	});

	it('rejects invalid contexts, awards, spends, and correction shapes', () => {
		const invalidContexts = [
			{ ...ctx, id: '' }, { ...ctx, at: 'bad' }, { ...ctx, reason: '' },
			{ ...ctx, reason: 'x'.repeat(1001) }, { ...ctx, sessionLabel: '' }, { ...ctx, sessionLabel: 'x'.repeat(201) }
		];
		for (const bad of invalidContexts) expect(applyXpAction(character(), { kind: 'award', presetId: 'quest' }, bad, content).ok).toBe(false);
		expect(applyXpAction(character(), { kind: 'award', presetId: 'missing' }, ctx, content).ok).toBe(false);
		expect(applyXpAction(character(), { kind: 'award', presetId: 'other' }, ctx, content).ok).toBe(false);
		expect(applyXpAction(character(), { kind: 'award', presetId: 'quest', amount: 2 }, ctx, content).ok).toBe(false);
		expect(success(applyXpAction(character(), { kind: 'award', presetId: 'other', amount: 2 }, { ...ctx, sessionLabel: 'Session 1' }, content)).experience).toBe(2);
		expect(applyXpAction(character(1), { kind: 'spend', amount: 0 }, ctx, content).ok).toBe(false);
		expect(applyXpAction(character(), { kind: 'correction', balanceDelta: Number.NaN }, ctx, content).ok).toBe(false);
		expect(applyXpAction(character(), { kind: 'correction', balanceDelta: -1 }, ctx, content).ok).toBe(false);
		expect(applyXpAction(character(), { kind: 'correction', balanceDelta: 0 }, ctx, content).ok).toBe(false);
		expect(applyXpAction(character(), { kind: 'correction', balanceDelta: 0, talent: { talentId: 'missing', xp: 0, state: 'in-training', preparedUses: 0 } }, ctx, content).ok).toBe(false);
		expect(applyXpAction(character(), { kind: 'correction', balanceDelta: 0, talent: { talentId: 'own', xp: 8, state: 'mastered', preparedUses: 0 } }, ctx, content).ok).toBe(false);
	});

	it('rejects invalid talent action variants', () => {
		const noAllocation = character(2); noAllocation.talents = [];
		expect(applyXpAction(noAllocation, { kind: 'talent-use', talentId: 'own' }, ctx, content).ok).toBe(false);
		expect(applyXpAction(character(2), { kind: 'talent-use', talentId: 'other' }, ctx, content).ok).toBe(false);
		const badCost = structuredClone(content); badCost.advancement.pathUseXp = 0;
		expect(applyXpAction(character(2), { kind: 'talent-use', talentId: 'own' }, ctx, badCost).ok).toBe(false);
		const noUses = character();
		expect(applyXpAction(noUses, { kind: 'prepared-use', talentId: 'other' }, ctx, content).ok).toBe(false);
		const mastered = character(); Object.assign(mastered.talents[1], { state: 'mastered', xp: 7, preparedUses: 0 });
		expect(applyXpAction(mastered, { kind: 'prepared-use', talentId: 'other' }, ctx, content).ok).toBe(true);
		const wounded = character(2); wounded.talents[1].wounded = true;
		expect(applyXpAction(wounded, { kind: 'mentoring', talentId: 'other', amount: 1, mentor: 'M', phase: 'camp' }, ctx, content).ok).toBe(false);
		const masteredMentor = character(2); Object.assign(masteredMentor.talents[1], { state: 'mastered', xp: 7 });
		expect(applyXpAction(masteredMentor, { kind: 'mentoring', talentId: 'other', amount: 1, mentor: 'M', phase: 'camp' }, ctx, content).ok).toBe(false);
		expect(applyXpAction(character(2), { kind: 'mentoring', talentId: 'other', amount: 0, mentor: 'M', phase: 'camp' }, ctx, content).ok).toBe(false);
		expect(applyXpAction(character(2), { kind: 'mentoring', talentId: 'other', amount: 1, mentor: '', phase: 'camp' }, ctx, content).ok).toBe(false);
		expect(applyXpAction(character(), { kind: 'mentoring', talentId: 'other', amount: 1, mentor: 'M', phase: 'camp' }, ctx, content).ok).toBe(false);
		const toMaster = character(1); Object.assign(toMaster.talents[1], { xp: 6, preparedUses: 2 });
		expect(success(applyXpAction(toMaster, { kind: 'mentoring', talentId: 'other', amount: 1, mentor: 'M', phase: 'camp' }, ctx, content)).talents[1]).toMatchObject({ state: 'mastered', preparedUses: 0 });
	});

	it('uses alternate configured mastery and path-use costs', () => {
		const alternate = structuredClone(content);
		alternate.advancement.masteryXp = 3;
		alternate.advancement.pathUseXp = 2;
		const input = character(2); input.talents[0].xp = 1;
		const result = success(applyXpAction(input, { kind: 'talent-use', talentId: 'own' }, ctx, alternate));
		expect(result.experience).toBe(0);
		expect(result.talents[0]).toMatchObject({ xp: 3, state: 'mastered' });
	});

	it('blocks ordinary actions when legacy talent progress exceeds mastery', () => {
		const input = character(3);
		input.talents[0].xp = 9;
		expect(validateExperience(input, 7).join(' ')).toMatch(/mastery/i);
		expect(applyXpAction(input, { kind: 'talent-use', talentId: 'own' }, ctx, content).ok).toBe(false);
	});

	it('allows successive corrections while preserving other malformed legacy talent fields', () => {
		const input = character(0);
		input.talents[0].xp = 9;
		input.talents[1].preparedUses = -2;
		const first = success(applyXpAction(input, { kind: 'correction', balanceDelta: 0, talent: { talentId: 'own', xp: 7, state: 'mastered', preparedUses: 0 } }, ctx, content));
		expect(validateExperience(first, 7)).not.toEqual([]);
		expect(validateExperienceChange(first, input, 7)).toEqual([]);
		const second = success(applyXpAction(first, { kind: 'correction', balanceDelta: 0, talent: { talentId: 'other', xp: 0, state: 'in-training', preparedUses: 0 } }, { ...ctx, id: 'entry-2' }, content));
		expect(validateExperienceChange(second, first, 7)).toEqual([]);
		expect(validateExperience(second, 7)).toEqual([]);
	});

	it('rejects preservation when a correction rewrites history or changes another malformed talent', () => {
		const input = character(0);
		input.talents[0].xp = 9;
		input.talents[1].preparedUses = -2;
		const next = structuredClone(input);
		next.talents[0].xp = 8;
		next.talents[1].preparedUses = 0;
		next.xpLedger.entries.push({ id: 'repair', at: ctx.at, delta: 0, kind: 'correction', sourceId: 'correction', sourceLabel: 'Correction', reason: 'repair', talentId: 'other', talentBefore: { xp: 0, state: 'in-training', preparedUses: -2 }, talentAfter: { xp: 0, state: 'in-training', preparedUses: 0 } });
		expect(validateExperienceChange(next, input, 7).length).toBeGreaterThan(0);
	});
});

it('can award XP after reconciling a decimal legacy balance without rounding drift', () => {
 const input = character(-1.1);
 const repaired = success(applyXpAction(input, { kind: 'correction', balanceDelta: 1.1 }, ctx, content));
 const awarded = success(applyXpAction(repaired, { kind: 'award', presetId: 'quest' }, { ...ctx, id: 'after-repair' }, content));
 expect(awarded.experience).toBe(3);
});

describe('validateExperienceTransition', () => {
	/**
	 * The server trusts a whole-document PUT and only ran this check for the
	 * single-correction case; every other action fell back to checking the new
	 * document's own arithmetic, never that a specific action was legitimate.
	 * These prove a hand-crafted request can no longer grant XP or mastery no
	 * client action could produce, and that real client-produced transitions —
	 * including a multi-action edit-mode batch — still validate clean.
	 */

	it('rejects a forged award that does not match its configured preset amount', () => {
		const previous = character(0);
		const next = structuredClone(previous);
		next.experience = 999;
		next.xpLedger.entries.push({ id: 'forged', at: ctx.at, delta: 999, kind: 'award', sourceId: 'quest', sourceLabel: 'Quest accepted', reason: 'Rescue the bellringer' });
		expect(validateExperienceTransition(next, previous, content)).not.toEqual([]);
	});

	it('rejects an award whose sourceId does not match any real preset', () => {
		const previous = character(0);
		const next = structuredClone(previous);
		next.experience = 3;
		next.xpLedger.entries.push({ id: 'forged', at: ctx.at, delta: 3, kind: 'award', sourceId: 'made-up-preset', sourceLabel: 'Quest accepted', reason: 'Rescue the bellringer' });
		expect(validateExperienceTransition(next, previous, content)).not.toEqual([]);
	});

	it('accepts talent progress marked directly on the sheet, with no ledger entry', () => {
		const previous = character(0);
		const stepped = structuredClone(previous);
		stepped.talents[0] = { ...stepped.talents[0], xp: 3 };
		expect(validateExperienceTransition(stepped, previous, content)).toEqual([]);
		const mastered = structuredClone(previous);
		mastered.talents[0] = { ...mastered.talents[0], xp: 7, state: 'mastered' };
		expect(validateExperienceTransition(mastered, previous, content)).toEqual([]);
	});

	it('rejects a talent-use entry that undercharges the configured cost', () => {
		const previous = character(1);
		const next = structuredClone(previous);
		next.talents[0] = { ...next.talents[0], xp: 7, state: 'mastered', preparedUses: 0 };
		next.xpLedger.entries.push({
			id: 'cheap', at: ctx.at, delta: 0, kind: 'talent-use', sourceId: 'own', sourceLabel: 'Own Talent',
			reason: 'Used in the field', talentId: 'own',
			talentBefore: { xp: 0, state: 'in-training', preparedUses: 0 },
			talentAfter: { xp: 7, state: 'mastered', preparedUses: 0 }
		});
		expect(validateExperienceTransition(next, previous, content)).not.toEqual([]);
	});

	it('rejects mentoring that pushes a talent past the remaining mastery cost', () => {
		const previous = character(10);
		previous.talents[1].preparedUses = 0;
		const next = structuredClone(previous);
		next.experience = 0;
		next.talents[1] = { ...next.talents[1], xp: 7, state: 'mastered', preparedUses: 0 };
		next.xpLedger.entries.push({
			id: 'overtrain', at: ctx.at, delta: -10, kind: 'mentoring', sourceId: 'other', sourceLabel: 'Other Talent — Mentor (camp)',
			reason: 'Extra training', talentId: 'other',
			talentBefore: { xp: 0, state: 'in-training', preparedUses: 0 },
			talentAfter: { xp: 7, state: 'mastered', preparedUses: 0 }
		});
		expect(validateExperienceTransition(next, previous, content)).not.toEqual([]);
	});

	it('rejects a talent-use entry that charges for an already-mastered talent', () => {
		const previous = character(1);
		previous.talents[0] = { ...previous.talents[0], xp: 0, state: 'mastered', preparedUses: 0 };
		const next = structuredClone(previous);
		next.experience = 0;
		next.talents[0] = { ...next.talents[0], xp: 1, state: 'in-training', preparedUses: 0 };
		next.xpLedger.entries.push({
			id: 'demote', at: ctx.at, delta: -1, kind: 'talent-use', sourceId: 'own', sourceLabel: 'Own Talent',
			reason: 'Used in the field', talentId: 'own',
			talentBefore: { xp: 0, state: 'mastered', preparedUses: 0 },
			talentAfter: { xp: 1, state: 'in-training', preparedUses: 0 }
		});
		expect(validateExperienceTransition(next, previous, content).join(' ')).toMatch(/mastered talent/);
	});

	it('rejects mentoring a migrated talent whose prepared-use count is still unknown', () => {
		const previous = character(2);
		previous.talents[1].preparedUses = null;
		const next = structuredClone(previous);
		next.experience = 0;
		next.talents[1] = { ...next.talents[1], xp: 2, preparedUses: 2 };
		next.xpLedger.entries.push({
			id: 'skip-reconcile', at: ctx.at, delta: -2, kind: 'mentoring', sourceId: 'other', sourceLabel: 'Other Talent — Mentor (camp)',
			reason: 'Training', talentId: 'other',
			talentBefore: { xp: 0, state: 'in-training', preparedUses: null },
			talentAfter: { xp: 2, state: 'in-training', preparedUses: 2 }
		});
		expect(validateExperienceTransition(next, previous, content).join(' ')).toMatch(/prepared uses set first/);
	});

	it('rejects replayed corrections that pass through a fractional or negative balance', () => {
		const previous = character(0);
		const halves = structuredClone(previous);
		halves.experience = 1;
		for (const id of ['half-1', 'half-2']) halves.xpLedger.entries.push({ id, at: ctx.at, delta: 0.5, kind: 'correction', sourceId: 'correction', sourceLabel: 'Correction', reason: 'Split' });
		expect(validateExperienceTransition(halves, previous, content).join(' ')).toMatch(/whole balance/);

		const dip = structuredClone(previous);
		dip.experience = 1;
		dip.xpLedger.entries.push({ id: 'down', at: ctx.at, delta: -2, kind: 'correction', sourceId: 'correction', sourceLabel: 'Correction', reason: 'Down' });
		dip.xpLedger.entries.push({ id: 'up', at: ctx.at, delta: 3, kind: 'correction', sourceId: 'correction', sourceLabel: 'Correction', reason: 'Up' });
		expect(validateExperienceTransition(dip, previous, content).join(' ')).toMatch(/whole balance/);
	});

	it('still accepts one fractional correction that repairs a legacy balance', () => {
		const previous = character(0);
		previous.experience = 0.5;
		previous.xpLedger.openingBalance = 0.5;
		const next = structuredClone(previous);
		next.experience = 1;
		next.xpLedger.entries.push({ id: 'round', at: ctx.at, delta: 0.5, kind: 'correction', sourceId: 'correction', sourceLabel: 'Correction', reason: 'Round up a legacy balance' });
		expect(validateExperienceTransition(next, previous, content)).toEqual([]);
	});

	it('rejects a rewritten ledger entry, even with the arithmetic still balanced', () => {
		const previous = success(applyXpAction(character(0), { kind: 'award', presetId: 'quest' }, ctx, content));
		const next = structuredClone(previous);
		next.xpLedger.entries[0] = { ...next.xpLedger.entries[0], reason: 'A different story entirely' };
		expect(validateExperienceTransition(next, previous, content)).not.toEqual([]);
	});

	it('still rejects a directly edited talent that breaks the mastery invariant', () => {
		const previous = character(0);
		const next = structuredClone(previous);
		next.talents[0] = { ...next.talents[0], xp: 9 };
		expect(validateExperienceTransition(next, previous, content)).not.toEqual([]);
	});

	it('accepts a real award, talent-use, and prepared-use produced by the engine itself', () => {
		let state = character(0);
		state = success(applyXpAction(state, { kind: 'award', presetId: 'quest' }, ctx, content));
		expect(validateExperienceTransition(state, character(0), content)).toEqual([]);

		const afterAward = structuredClone(state);
		state = success(applyXpAction(state, { kind: 'talent-use', talentId: 'own' }, { ...ctx, id: 'use-1' }, content));
		expect(validateExperienceTransition(state, afterAward, content)).toEqual([]);

		const afterUse = structuredClone(state);
		state = success(applyXpAction(state, { kind: 'mentoring', talentId: 'other', amount: 2, mentor: 'Grendel', phase: 'camp' }, { ...ctx, id: 'mentor-1' }, content));
		expect(validateExperienceTransition(state, afterUse, content)).toEqual([]);

		const afterMentor = structuredClone(state);
		state = success(applyXpAction(state, { kind: 'prepared-use', talentId: 'other' }, { ...ctx, id: 'prepared-1' }, content));
		expect(validateExperienceTransition(state, afterMentor, content)).toEqual([]);
	});

	it('accepts an edit-mode batch of two actions applied before a single save', () => {
		const previous = character(0);
		let batched = success(applyXpAction(previous, { kind: 'award', presetId: 'quest' }, ctx, content));
		batched = success(applyXpAction(batched, { kind: 'talent-use', talentId: 'own' }, { ...ctx, id: 'use-1' }, content));
		expect(validateExperienceTransition(batched, previous, content)).toEqual([]);
	});

	it('accepts a documented correction alongside the internal-consistency check it replaces', () => {
		const previous = character(0);
		previous.talents[0].xp = 9; // a legacy anomaly
		const next = success(applyXpAction(previous, { kind: 'correction', balanceDelta: 0, talent: { talentId: 'own', xp: 7, state: 'mastered', preparedUses: 0 } }, ctx, content));
		expect(validateExperienceTransition(next, previous, content)).toEqual([]);
	});
});
