/**
 * Server-side "is this adventurer actually finished and legal?" check. Runs
 * before persisting a non-draft character so the database never holds a
 * finished adventurer that violates the core creation rules. Draft saves skip
 * this — you can save an incomplete adventurer as a draft freely.
 */

import type { GuildBookCharacterData } from '$lib/types/character';
import { SUIT_IDS, type SuitId } from '$lib/types/common';
import { getContentPack, getPaths, getKiths } from '$lib/server/content/loader';

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
