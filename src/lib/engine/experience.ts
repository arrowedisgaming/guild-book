import type { AdvancementConfig, PathDefinition, TalentDefinition } from '$lib/types/content-pack';
import type { GuildBookCharacterData, TalentAllocation, XpEntry, XpTalentSnapshot } from '$lib/types/character';
import type { TalentState } from '$lib/types/common';

export type XpAction =
	| { kind: 'award'; presetId: string; amount?: number }
	| { kind: 'spend'; amount: number }
	| { kind: 'talent-use'; talentId: string }
	| { kind: 'mentoring'; talentId: string; amount: number; mentor: string; phase: 'camp' | 'city' }
	| { kind: 'prepared-use'; talentId: string }
	| { kind: 'correction'; balanceDelta: number; talent?: { talentId: string; xp: number; state: 'mastered' | 'in-training'; preparedUses: number } };

export interface XpRecordContext { id: string; at: string; reason: string; sessionLabel?: string }
export interface ExperienceContent { advancement: AdvancementConfig; paths: PathDefinition[]; talents: TalentDefinition[] }
export type XpResult = { ok: true; character: GuildBookCharacterData } | { ok: false; error: string };

export function validateExperience(character: GuildBookCharacterData, masteryXp?: number): string[] {
	return validateExperienceInternal(character, masteryXp, new Set());
}

function validateExperienceInternal(character: GuildBookCharacterData, masteryXp: number | undefined, preservedTalentIds: ReadonlySet<string>): string[] {
	const errors: string[] = [];
	if (!Number.isSafeInteger(character.experience) || character.experience < 0) {
		errors.push('Available XP must be a nonnegative safe integer.');
	}
	if (!Number.isFinite(character.xpLedger.openingBalance)) {
		errors.push('XP opening balance must be finite.');
	}
	const ids = new Set<string>();
	for (const entry of character.xpLedger.entries) {
		if (!entry.id.trim()) errors.push('XP entry IDs must be nonempty.');
		else if (ids.has(entry.id)) errors.push(`Duplicate XP entry ID: ${entry.id}.`);
		ids.add(entry.id);
		if (!Number.isFinite(entry.delta) || Math.abs(entry.delta) > Number.MAX_SAFE_INTEGER || (entry.kind !== 'correction' && !Number.isSafeInteger(entry.delta))) errors.push(`XP entry ${entry.id} delta must be a safe integer.`);
		if (!Number.isFinite(Date.parse(entry.at))) errors.push(`XP entry ${entry.id} timestamp is invalid.`);
		if (!entry.reason.trim() || entry.reason.length > 1000) errors.push(`XP entry ${entry.id} reason must be 1–1000 characters.`);
		if (!entry.sourceLabel.trim() || entry.sourceLabel.length > 200) errors.push(`XP entry ${entry.id} source label must be 1–200 characters.`);
		if (entry.sessionLabel !== undefined && (!entry.sessionLabel.trim() || entry.sessionLabel.length > 200)) errors.push(`XP entry ${entry.id} session label must be 1–200 characters.`);
		if (entry.kind === 'award' && entry.delta <= 0) errors.push(`XP award ${entry.id} must be positive.`);
		if (['spend', 'talent-use', 'mentoring'].includes(entry.kind) && entry.delta >= 0) errors.push(`XP spend ${entry.id} must be negative.`);
		if (entry.kind === 'correction' && entry.delta === 0 && (!entry.talentBefore || !entry.talentAfter || JSON.stringify(entry.talentBefore) === JSON.stringify(entry.talentAfter))) errors.push(`Zero-delta correction ${entry.id} must repair talent state.`);
	}
	for (const talent of character.talents) {
		if (preservedTalentIds.has(talent.talentId)) continue;
		if (!Number.isSafeInteger(talent.xp) || talent.xp < 0) errors.push(`Talent ${talent.talentId} XP must be a nonnegative safe integer.`);
		if (talent.preparedUses !== null && (!Number.isSafeInteger(talent.preparedUses) || talent.preparedUses < 0)) errors.push(`Talent ${talent.talentId} prepared uses must be null or a nonnegative safe integer.`);
		if (masteryXp !== undefined && (!Number.isSafeInteger(masteryXp) || masteryXp <= 0)) errors.push('Talent mastery threshold must be a positive safe integer.');
		else if (masteryXp !== undefined && (talent.xp > masteryXp || (talent.state === 'in-training' && talent.xp >= masteryXp))) errors.push(`Talent ${talent.talentId} XP is inconsistent with the mastery threshold.`);
	}
	const expected = character.xpLedger.entries.reduce((sum, entry) => sum + entry.delta, character.xpLedger.openingBalance);
	if (Number.isFinite(expected) && character.experience !== expected) errors.push('Available XP does not match its ledger.');
	return errors;
}

export function validateExperienceChange(next: GuildBookCharacterData, previous: GuildBookCharacterData, masteryXp?: number): string[] {
	const errors: string[] = [];
	if (next.xpLedger.openingBalance !== previous.xpLedger.openingBalance) errors.push('A correction cannot rewrite the XP opening balance.');
	if (next.xpLedger.entries.length !== previous.xpLedger.entries.length + 1 || !previous.xpLedger.entries.every((entry, index) => JSON.stringify(entry) === JSON.stringify(next.xpLedger.entries[index]))) errors.push('A correction must append exactly one ledger entry without rewriting history.');
	const correction = next.xpLedger.entries.at(-1);
	if (!correction || correction.kind !== 'correction') errors.push('The appended XP entry must be a correction.');
	const beforeById = new Map(previous.talents.map((talent) => [talent.talentId, talent]));
	const afterById = new Map(next.talents.map((talent) => [talent.talentId, talent]));
	if (beforeById.size !== afterById.size || [...beforeById.keys()].some((id) => !afterById.has(id))) errors.push('A correction cannot add or remove talents.');
	const preserved = new Set<string>();
	for (const [id, after] of afterById) {
		const before = beforeById.get(id);
		if (!before) continue;
		const unchanged = before.xp === after.xp && before.state === after.state && before.preparedUses === after.preparedUses;
		if (unchanged) preserved.add(id);
		else if (id !== correction?.talentId) errors.push(`A correction cannot also change talent ${id}.`);
	}
	if (correction?.talentId) {
		const before = beforeById.get(correction.talentId);
		const after = afterById.get(correction.talentId);
		if (!before || !after || JSON.stringify(correction.talentBefore) !== JSON.stringify(snapshot(before)) || JSON.stringify(correction.talentAfter) !== JSON.stringify(snapshot(after))) errors.push('Correction talent snapshots must match the character change.');
	}
	return [...errors, ...validateExperienceInternal(next, masteryXp, preserved)];
}

/**
 * Server-side guard: does this transition from `previous` to `next` reflect a
 * real ledger action — not just an internally self-consistent document?
 *
 * `validateExperienceChange` only proves history wasn't rewritten for the
 * single-correction case; every other action kind used to fall back to
 * `validateExperience`, which checks the new document alone and never asks
 * whether an award matched a real preset or a talent-use charged the real
 * cost. This replays every newly appended entry (there can be more than one —
 * edit-mode batches several actions before Save) against the state at the
 * moment each was recorded, so a hand-crafted request can't grant XP no
 * client action could.
 *
 * Corrections are the deliberate exception: they may repair balance/talent
 * state freely, so they're checked only for internal shape, not real cost.
 *
 * Talent progress itself is marked directly on the sheet (the +/− steppers in
 * TalentsEdit), so a talent changing with no ledger entry is legitimate; only a
 * talent an appended entry claims to have changed must match that entry.
 */
export function validateExperienceTransition(
	next: GuildBookCharacterData,
	previous: GuildBookCharacterData,
	content: ExperienceContent
): string[] {
	const errors: string[] = [];
	if (next.xpLedger.openingBalance !== previous.xpLedger.openingBalance) {
		errors.push('XP opening balance cannot be rewritten.');
	}
	const prevEntries = previous.xpLedger.entries;
	const nextEntries = next.xpLedger.entries;
	const historyIntact =
		nextEntries.length >= prevEntries.length &&
		prevEntries.every((entry, i) => JSON.stringify(entry) === JSON.stringify(nextEntries[i]));
	if (!historyIntact) return [...errors, 'XP ledger history cannot be rewritten or shortened.'];

	const runningTalents = new Map(previous.talents.map((t) => [t.talentId, { ...t }]));
	let runningExperience = previous.experience;
	const touchedTalentIds = new Set<string>();

	for (const entry of nextEntries.slice(prevEntries.length)) {
		const before = entry.talentId ? runningTalents.get(entry.talentId) : undefined;
		if (entry.talentId) touchedTalentIds.add(entry.talentId);

		if (entry.kind === 'award') {
			if (entry.talentId) { errors.push(`Award ${entry.id} cannot reference a talent.`); continue; }
			const preset = content.advancement.awards.find((a) => a.id === entry.sourceId);
			if (!preset) errors.push(`Award ${entry.id} does not match a known preset.`);
			else if (preset.amount !== null && entry.delta !== preset.amount) errors.push(`Award ${entry.id} amount does not match its preset.`);
			runningExperience += entry.delta;
		} else if (entry.kind === 'spend') {
			if (entry.talentId) { errors.push(`Spend ${entry.id} cannot reference a talent.`); continue; }
			if (runningExperience + entry.delta < 0) errors.push(`Spend ${entry.id} exceeds the XP available at the time.`);
			runningExperience += entry.delta;
		} else if (entry.kind === 'talent-use') {
			if (!entry.talentId || !before) { errors.push(`Talent-use ${entry.id} references an unknown talent.`); continue; }
			if (before.wounded) errors.push(`Talent-use ${entry.id} targets a wounded talent.`);
			// Using a mastered talent is free and records nothing (applyXpAction).
			if (before.state === 'mastered') errors.push(`Talent-use ${entry.id} charges for a mastered talent.`);
			if (!isOwnPathTalent(next.pathId, entry.talentId, content.paths)) errors.push(`Talent-use ${entry.id} is not on the character's own path.`);
			const cost = content.advancement.pathUseXp;
			if (entry.delta !== -cost) errors.push(`Talent-use ${entry.id} does not charge the configured cost.`);
			if (runningExperience + entry.delta < 0) errors.push(`Talent-use ${entry.id} exceeds the XP available at the time.`);
			if (JSON.stringify(entry.talentBefore) !== JSON.stringify(snapshot(before))) errors.push(`Talent-use ${entry.id} does not match the talent's actual prior state.`);
			const expectedXp = Math.min(before.xp + cost, content.advancement.masteryXp);
			const expectedState: TalentState = expectedXp >= content.advancement.masteryXp ? 'mastered' : 'in-training';
			const after: XpTalentSnapshot = { xp: expectedXp, state: expectedState, preparedUses: expectedState === 'mastered' ? 0 : before.preparedUses };
			if (JSON.stringify(entry.talentAfter) !== JSON.stringify(after)) errors.push(`Talent-use ${entry.id} does not produce the expected talent state.`);
			runningExperience += entry.delta;
			runningTalents.set(entry.talentId, { ...before, ...after });
		} else if (entry.kind === 'mentoring') {
			if (!entry.talentId || !before) { errors.push(`Mentoring ${entry.id} references an unknown talent.`); continue; }
			if (before.wounded) errors.push(`Mentoring ${entry.id} targets a wounded talent.`);
			// Same preconditions as applyXpAction: an unknown legacy prepared-use
			// count must be reconciled first, never silently read as zero.
			if (before.state === 'mastered') errors.push(`Mentoring ${entry.id} targets a mastered talent.`);
			if (before.preparedUses === null) errors.push(`Mentoring ${entry.id} needs remaining prepared uses set first.`);
			if (isOwnPathTalent(next.pathId, entry.talentId, content.paths) || !content.paths.some((p) => p.talentIds.includes(entry.talentId!))) errors.push(`Mentoring ${entry.id} must target another path's talent.`);
			const amount = -entry.delta;
			if (!isPositiveInteger(amount)) errors.push(`Mentoring ${entry.id} amount is invalid.`);
			if (before.xp + amount > content.advancement.masteryXp) errors.push(`Mentoring ${entry.id} exceeds the remaining mastery cost.`);
			if (runningExperience + entry.delta < 0) errors.push(`Mentoring ${entry.id} exceeds the XP available at the time.`);
			if (JSON.stringify(entry.talentBefore) !== JSON.stringify(snapshot(before))) errors.push(`Mentoring ${entry.id} does not match the talent's actual prior state.`);
			const expectedXp = before.xp + amount;
			const expectedState: TalentState = expectedXp === content.advancement.masteryXp ? 'mastered' : 'in-training';
			const after: XpTalentSnapshot = { xp: expectedXp, state: expectedState, preparedUses: expectedState === 'mastered' ? 0 : (before.preparedUses ?? 0) + amount };
			if (JSON.stringify(entry.talentAfter) !== JSON.stringify(after)) errors.push(`Mentoring ${entry.id} does not produce the expected talent state.`);
			runningExperience += entry.delta;
			runningTalents.set(entry.talentId, { ...before, ...after });
		} else if (entry.kind === 'correction') {
			if (entry.talentId) {
				if (!before) { errors.push(`Correction ${entry.id} references an unknown talent.`); continue; }
				if (JSON.stringify(entry.talentBefore) !== JSON.stringify(snapshot(before))) errors.push(`Correction ${entry.id} does not match the talent's actual prior state.`);
				if (!entry.talentAfter || !isValidTalentSnapshot(entry.talentAfter, content.advancement.masteryXp)) errors.push(`Correction ${entry.id} does not produce a valid talent state.`);
				else runningTalents.set(entry.talentId, { ...before, ...entry.talentAfter });
			} else if (entry.talentBefore || entry.talentAfter) {
				errors.push(`Correction ${entry.id} talent snapshot requires a talentId.`);
			}
			runningExperience += entry.delta;
			// As in applyXpAction: a correction may carry a fractional delta to
			// repair a legacy balance, but must land on a whole, nonnegative one.
			if (!Number.isSafeInteger(runningExperience) || runningExperience < 0) errors.push(`Correction ${entry.id} must produce a nonnegative whole balance.`);
		}
	}

	if (runningExperience !== next.experience) errors.push('Available XP does not match the replayed ledger.');

	// A talent left exactly as it was is "preserved" — exempt from the
	// per-talent invariant checks below, so repairing one legacy anomaly is
	// never blocked by a different anomaly on a talent that wasn't touched.
	// Anything that did change (by stepper or by ledger entry) is checked.
	const preservedTalentIds = new Set<string>();
	for (const nextTalent of next.talents) {
		const prevTalent = previous.talents.find((t) => t.talentId === nextTalent.talentId);
		if (!prevTalent) continue;
		if (touchedTalentIds.has(nextTalent.talentId)) {
			const expected = runningTalents.get(nextTalent.talentId);
			if (expected && (nextTalent.xp !== expected.xp || nextTalent.state !== expected.state || nextTalent.preparedUses !== expected.preparedUses)) {
				errors.push(`Talent ${nextTalent.talentId} does not match its ledger-derived state.`);
			}
			continue;
		}
		if (nextTalent.xp === prevTalent.xp && nextTalent.state === prevTalent.state && nextTalent.preparedUses === prevTalent.preparedUses) {
			preservedTalentIds.add(nextTalent.talentId);
		}
	}

	return [...errors, ...validateExperienceInternal(next, content.advancement.masteryXp, preservedTalentIds)];
}
function isValidTalentSnapshot(snap: XpTalentSnapshot, masteryXp: number): boolean {
	if (!Number.isSafeInteger(snap.xp) || snap.xp < 0 || snap.xp > masteryXp) return false;
	if (snap.state === 'mastered') return (snap.xp === 0 || snap.xp === masteryXp) && snap.preparedUses === 0;
	return snap.xp < masteryXp && (snap.preparedUses === null || (Number.isSafeInteger(snap.preparedUses) && snap.preparedUses >= 0));
}

export function applyXpAction(character: GuildBookCharacterData, action: XpAction, context: XpRecordContext, content: ExperienceContent): XpResult {
	if (action.kind !== 'correction') {
		const existingErrors = validateExperience(character, content.advancement.masteryXp);
		if (existingErrors.length) return failure(`Correct invalid XP before continuing: ${existingErrors[0]}`);
	}
	const duplicateTalent = character.talents.some((talent, index) => character.talents.findIndex((other) => other.talentId === talent.talentId) !== index);
	if (duplicateTalent) return failure('Character has duplicate talent allocations.');
	if (action.kind !== 'prepared-use') {
		const contextError = validateContext(context, character);
		if (contextError) return failure(contextError);
	}

	const next = structuredClone(character);
	if (action.kind === 'award') {
		const preset = content.advancement.awards.find((award) => award.id === action.presetId);
		if (!preset) return failure('Unknown XP award preset.');
		const amount = preset.amount ?? action.amount;
		if (!isPositiveInteger(amount)) return failure('Award amount must be a positive integer.');
		if (preset.amount !== null && action.amount !== undefined && action.amount !== preset.amount) return failure('Configured award amount cannot be changed.');
		return append(next, context, { delta: amount, kind: 'award', sourceId: preset.id, sourceLabel: preset.label });
	}
	if (action.kind === 'spend') {
		if (!isPositiveInteger(action.amount)) return failure('Spend amount must be a positive integer.');
		if (next.experience < action.amount) return failure('Insufficient available XP.');
		return append(next, context, { delta: -action.amount, kind: 'spend', sourceId: 'other-spend', sourceLabel: 'Other spending' });
	}
	if (action.kind === 'prepared-use') {
		const talent = findTalent(next, action.talentId, content);
		if (typeof talent === 'string') return failure(talent);
		if (talent.wounded) return failure('Wounded talents cannot be used.');
		if (isOwnPathTalent(next.pathId, action.talentId, content.paths) || !content.paths.some((path) => path.talentIds.includes(action.talentId))) return failure('Prepared uses apply only to another path\'s talent.');
		if (talent.state === 'mastered') return { ok: true, character: next };
		if (talent.preparedUses === null) return failure('Set remaining prepared uses before using this talent.');
		if (talent.preparedUses < 1) return failure('No prepared uses remain.');
		talent.preparedUses -= 1;
		return finish(next, content.advancement.masteryXp);
	}
	if (action.kind === 'talent-use') {
		const talent = findTalent(next, action.talentId, content);
		if (typeof talent === 'string') return failure(talent);
		if (!isOwnPathTalent(next.pathId, action.talentId, content.paths)) return failure('Talent is not on the character\'s own path.');
		if (talent.wounded) return failure('Wounded talents cannot be used.');
		if (talent.state === 'mastered') return { ok: true, character: next };
		const cost = content.advancement.pathUseXp;
		if (!isPositiveInteger(cost)) return failure('Path-use XP cost is invalid.');
		if (next.experience < cost) return failure('Insufficient available XP.');
		const before = snapshot(talent);
		talent.xp += cost;
		if (talent.xp >= content.advancement.masteryXp) { talent.xp = content.advancement.masteryXp; talent.state = 'mastered'; talent.preparedUses = 0; }
		return append(next, context, { delta: -cost, kind: 'talent-use', sourceId: action.talentId, sourceLabel: talentName(action.talentId, content), talentId: action.talentId, talentBefore: before, talentAfter: snapshot(talent) });
	}
	if (action.kind === 'mentoring') {
		const talent = findTalent(next, action.talentId, content);
		if (typeof talent === 'string') return failure(talent);
		if (talent.wounded) return failure('Wounded talents cannot be trained.');
		if (talent.state === 'mastered') return failure('Mastered talents cannot be trained.');
		if (talent.preparedUses === null) return failure('Set remaining prepared uses before further training.');
		if (!isPositiveInteger(action.amount)) return failure('Training amount must be a positive integer.');
		if (!action.mentor.trim() || action.mentor.length > 200) return failure('Mentor must be 1–200 characters.');
		if (isOwnPathTalent(next.pathId, action.talentId, content.paths) || !content.paths.some((path) => path.talentIds.includes(action.talentId))) return failure('Only another path\'s talent can be mentored.');
		if (talent.xp + action.amount > content.advancement.masteryXp) return failure('Training exceeds the remaining mastery cost.');
		if (next.experience < action.amount) return failure('Insufficient available XP.');
		const before = snapshot(talent);
		talent.xp += action.amount;
		talent.preparedUses += action.amount;
		if (talent.xp === content.advancement.masteryXp) { talent.state = 'mastered'; talent.preparedUses = 0; }
		return append(next, context, { delta: -action.amount, kind: 'mentoring', sourceId: action.talentId, sourceLabel: `${talentName(action.talentId, content)} — ${action.mentor} (${action.phase})`, talentId: action.talentId, talentBefore: before, talentAfter: snapshot(talent) });
	}

	if (!Number.isFinite(action.balanceDelta)) return failure('Correction balance delta must be finite.');
	const finalBalance = next.experience + action.balanceDelta;
	if (!Number.isInteger(finalBalance) || finalBalance < 0) return failure('Correction must produce a nonnegative integer balance.');
	let talentFields: Pick<XpEntry, 'talentId' | 'talentBefore' | 'talentAfter'> = {};
	if (action.talent) {
		const talent = next.talents.find((item) => item.talentId === action.talent!.talentId);
		if (!talent) return failure('Unknown character talent.');
		if (!isValidTalentRepair(action.talent, content.advancement.masteryXp)) return failure('Corrected talent progress is invalid.');
		const before = snapshot(talent);
		Object.assign(talent, { xp: action.talent.xp, state: action.talent.state, preparedUses: action.talent.preparedUses });
		talentFields = { talentId: talent.talentId, talentBefore: before, talentAfter: snapshot(talent) };
	}
	if (action.balanceDelta === 0 && !action.talent) return failure('A zero-balance correction must repair talent state.');
	const fields = { delta: action.balanceDelta, kind: 'correction' as const, sourceId: 'correction', sourceLabel: action.talent ? `Correction — ${talentName(action.talent.talentId, content)}` : 'Correction', ...talentFields };
	next.experience += fields.delta;
	next.xpLedger.entries.push({ ...fields, id: context.id, at: context.at, reason: context.reason.trim(), ...(context.sessionLabel === undefined ? {} : { sessionLabel: context.sessionLabel.trim() }) });
	const errors = validateExperienceChange(next, character, content.advancement.masteryXp);
	return errors.length ? failure(errors[0]) : { ok: true, character: next };
}

function append(character: GuildBookCharacterData, context: XpRecordContext, fields: Omit<XpEntry, 'id' | 'at' | 'reason' | 'sessionLabel'>): XpResult {
	character.experience += fields.delta;
	character.xpLedger.entries.push({ ...fields, id: context.id, at: context.at, reason: context.reason.trim(), ...(context.sessionLabel === undefined ? {} : { sessionLabel: context.sessionLabel.trim() }) });
	return finish(character);
}
function finish(character: GuildBookCharacterData, masteryXp?: number): XpResult { const errors = validateExperience(character, masteryXp); return errors.length ? failure(errors[0]) : { ok: true, character }; }
function failure(error: string): XpResult { return { ok: false, error }; }
function isPositiveInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function validateContext(context: XpRecordContext, character: GuildBookCharacterData): string | null {
	if (!context.id.trim()) return 'XP entry ID is required.';
	if (character.xpLedger.entries.some((entry) => entry.id === context.id)) return 'XP entry ID has already been used.';
	if (!Number.isFinite(Date.parse(context.at))) return 'XP entry timestamp is invalid.';
	if (!context.reason.trim() || context.reason.length > 1000) return 'Reason must be 1–1000 characters.';
	if (context.sessionLabel !== undefined && (!context.sessionLabel.trim() || context.sessionLabel.length > 200)) return 'Session label must be 1–200 characters.';
	return null;
}
function findTalent(character: GuildBookCharacterData, talentId: string, content: ExperienceContent): TalentAllocation | string {
	if (!content.talents.some((talent) => talent.id === talentId)) return 'Unknown talent.';
	return character.talents.find((talent) => talent.talentId === talentId) ?? 'Character does not have that talent.';
}
function isOwnPathTalent(pathId: string | null, talentId: string, paths: PathDefinition[]): boolean { return paths.find((path) => path.id === pathId)?.talentIds.includes(talentId) ?? false; }
function talentName(id: string, content: ExperienceContent): string { return content.talents.find((talent) => talent.id === id)?.name ?? id; }
function snapshot(talent: TalentAllocation): XpTalentSnapshot { return { xp: talent.xp, state: talent.state, preparedUses: talent.preparedUses }; }
function isValidTalentRepair(talent: NonNullable<Extract<XpAction, { kind: 'correction' }>['talent']>, masteryXp: number): boolean {
	return Number.isSafeInteger(talent.xp) && talent.xp >= 0 && talent.xp <= masteryXp && Number.isSafeInteger(talent.preparedUses) && talent.preparedUses >= 0 && ((talent.state === 'mastered' && (talent.xp === 0 || talent.xp === masteryXp) && talent.preparedUses === 0) || (talent.state === 'in-training' && talent.xp < masteryXp));
}
