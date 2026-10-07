/**
 * Server-side "is this adventurer actually finished and legal?" check. Runs
 * before persisting a non-draft character so the database never holds a
 * finished adventurer that violates the core creation rules. Draft saves skip
 * this — you can save an incomplete adventurer as a draft freely.
 */

import type { GuildBookCharacterData } from '$lib/types/character';
import { validateExperience, validateExperienceTransition } from '$lib/engine/experience';
import { SUIT_IDS, type SuitId } from '$lib/types/common';
import { getContentPack, getPaths, getTalents, getKiths } from '$lib/server/content/loader';

export interface ValidationResult {
	valid: boolean;
	errors: string[];
}

export function validateFinalCharacter(char: GuildBookCharacterData): ValidationResult {
	const errors: string[] = [];
	const pack = getContentPack();

	// Kith / Kin / Path chosen and internally consistent.
	const kiths = getKiths();
	const kith = kiths.find((k) => k.id === char.kithId);
	if (!kith) {
		errors.push('Choose a kith.');
	} else if (!kith.kins.some((kin) => kin.id === char.kinId)) {
		errors.push('Choose a kin belonging to your kith.');
	}

	const path = getPaths().find((p) => p.id === char.pathId);
	if (!path) errors.push('Choose a path.');

	// Attribute values must be exactly the configured spread (default 4/3/2/1).
	const expected = [...pack.creation.attributeSpread].sort((a, b) => a - b);
	const actual = SUIT_IDS.map((s) => char.attributes[s]?.value ?? 0).sort((a, b) => a - b);
	const spreadMatches =
		expected.length === actual.length && expected.every((v, i) => v === actual[i]);
	if (!spreadMatches) {
		errors.push(`Assign the ${pack.creation.attributeSpread.join('/')} attribute spread.`);
	}

	// The highest attribute must be the path's suit.
	if (spreadMatches && pack.creation.highestAttributeFromPath && path) {
		const highest = Math.max(...pack.creation.attributeSpread);
		const highestSuit = (SUIT_IDS as readonly SuitId[]).find(
			(s) => char.attributes[s]?.value === highest
		);
		if (highestSuit && highestSuit !== path.suit) {
			errors.push(`Your highest attribute must be ${path.suit} to match the ${path.name}.`);
		}
	}

	// Motif count ceiling.
	if (char.motifs.length > pack.creation.motifCount) {
		errors.push(`An adventurer has at most ${pack.creation.motifCount} motifs.`);
	}

	return { valid: errors.length === 0, errors };
}

/** Validate play bookkeeping for drafts too; unrelated edits may preserve legacy anomalies. */
export function validateCharacterPlayState(char: GuildBookCharacterData, previous?: GuildBookCharacterData, opts: { native?: boolean } = {}): ValidationResult {
 const errors: string[] = [];
 // Fractional XP exists only to let legacy balances be repaired; a document
 // created natively at the current schema has no such history to preserve.
 if (opts.native && (!Number.isSafeInteger(char.xpLedger.openingBalance) || char.xpLedger.entries.some(e => !Number.isSafeInteger(e.delta)))) {
  errors.push('XP opening balance and ledger amounts must be whole numbers.');
 }
 const xpSlice = (c: GuildBookCharacterData) => JSON.stringify({ experience: c.experience, xpLedger: c.xpLedger,
  talents: c.talents.map(t => ({ talentId: t.talentId, xp: t.xp, state: t.state, preparedUses: t.preparedUses })) });
 const pack = getContentPack();
 const masteryXp = pack.advancement.masteryXp;
 if (!previous) errors.push(...validateExperience(char, masteryXp));
 else if (xpSlice(char) !== xpSlice(previous)) {
  // Replay every newly appended ledger entry against the state it was
  // recorded against — not just checking the new document's own arithmetic —
  // so a hand-crafted request can't grant XP or mastery no client action
  // could (a fabricated award, an unpaid talent-use, rewritten history).
  errors.push(...validateExperienceTransition(char, previous, { advancement: pack.advancement, paths: getPaths(), talents: getTalents() }));
 }
 const config = getContentPack().sorcery;
 for (const e of char.equipment) {
  if (!e.spellComponent) continue;
  if (e.itemId !== null || !e.customName?.trim() || e.customName.length > 2000) errors.push('A spell component needs a custom description, up to 2,000 characters.');
  if (e.packSpace !== config.componentSlots) errors.push('Spell component slots must match the content pack.');
  if (e.location === 'worn') errors.push('Spell components must be carried in your pack, belt, or hand.');
  if (!Number.isSafeInteger(e.quantity) || e.quantity < 1) errors.push('Component quantity must be a positive integer.');
  if (e.spellComponent.spellName.length > 200 || e.spellComponent.notes.length > 4000) errors.push('Component spell name or notes are too long.');
  if (e.spellComponent.spellId && !e.spellComponent.spellName.trim()) errors.push('A linked component needs a spell name.');
 }
 return { valid: errors.length === 0, errors };
}
