/**
 * Shared primitives for the His Majesty the Worm rules model.
 *
 * These are the few unions that are stable in the system itself (the four
 * tarot suits, the card ranks, item tiers). Everything content-authored —
 * kiths, kins, paths, talents, individual items — is referenced by plain
 * string id so the placeholder pack can be swapped for the real rulebook data
 * without touching these types.
 */

/**
 * The four suits. In HMTW the suits are simultaneously the tarot suits AND the
 * four attributes — Swords, Pentacles, Cups, Wands — so a single union serves
 * both the deck and the character sheet.
 */
export const SUIT_IDS = ['swords', 'pentacles', 'cups', 'wands'] as const;
export type SuitId = (typeof SUIT_IDS)[number];

/** An attribute is one of the four suits; alias kept for sheet-side readability. */
export type AttributeId = SuitId;

export function isSuitId(value: unknown): value is SuitId {
	return typeof value === 'string' && (SUIT_IDS as readonly string[]).includes(value);
}

/** Human-facing suit labels and their alternate ("classic" tarot) names. */
export const SUIT_LABELS: Record<SuitId, string> = {
	swords: 'Swords',
	pentacles: 'Pentacles',
	cups: 'Cups',
	wands: 'Wands'
};

/**
 * Minor-arcana ranks. HMTW numbers the pips I–X and uses the four court cards.
 * `numeric` is the value added on a test of fate; court-card values come from
 * the content pack's tarot config, but the ordering is fixed here.
 */
export const RANK_IDS = [
	'i',
	'ii',
	'iii',
	'iv',
	'v',
	'vi',
	'vii',
	'viii',
	'ix',
	'x',
	'page',
	'knight',
	'queen',
	'king'
] as const;
export type RankId = (typeof RANK_IDS)[number];

export function isRankId(value: unknown): value is RankId {
	return typeof value === 'string' && (RANK_IDS as readonly string[]).includes(value);
}

/** True for the four court cards (Page/Knight/Queen/King). */
export function isCourtRank(rank: RankId): boolean {
	return rank === 'page' || rank === 'knight' || rank === 'queen' || rank === 'king';
}

/**
 * Omphalic Market item tiers. Creation allows 1 luxurious, 5 common, and any
 * number of impoverished items (a talent's required items are impoverished for
 * that adventurer).
 */
export const ITEM_TIERS = ['luxurious', 'common', 'impoverished'] as const;
export type ItemTier = (typeof ITEM_TIERS)[number];

export function isItemTier(value: unknown): value is ItemTier {
	return typeof value === 'string' && (ITEM_TIERS as readonly string[]).includes(value);
}

/**
 * Talent mastery state. A path grants seven talents; one is mastered at
 * creation and the rest are "in training" until practised. The kin talent
 * begins mastered.
 */
export const TALENT_STATES = ['mastered', 'in-training'] as const;
export type TalentState = (typeof TALENT_STATES)[number];

/** Where a talent comes from — used for grouping and creation rules. */
export const TALENT_SOURCES = ['kin', 'path', 'arete', 'general'] as const;
export type TalentSource = (typeof TALENT_SOURCES)[number];

/** The creation-time attribute spread: the 4 is locked to the path's suit. */
export const ATTRIBUTE_SPREAD = [4, 3, 2, 1] as const;
