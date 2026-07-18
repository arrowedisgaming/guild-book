/**
 * Normalizes `SessionEngineStateV1`'s various zone shapes (fixed deck/hand
 * fields, addressable private/public/pending zone arrays) into one common
 * `ZoneDescriptor` list. Pure — no UI/DB/network imports (see
 * `tests/unit/session/import-boundaries.test.ts`).
 */

import type { CardId, SessionEngineStateV1, UserId } from '$lib/types/session';

/** `'both'` is an explicit domain declaration — not an escape hatch — for
 * zones where the spec genuinely mixes decks (e.g. the GM plays major-deck
 * cards and players play player-deck cards into the same public area). The
 * deck-ownership invariant still runs for `'both'` zones; it just accepts
 * any catalog card there by declaration. */
export type ZoneDeck = 'major' | 'player' | 'both';

/**
 * `hidden` — identities are secret; only a count may be public (draw piles).
 * `public-top` — the pile is secret except its top card, which is public
 * (discard piles; multiple rules inspect a specific pile's top — spec §9).
 * `public` — every card in the zone is public.
 * `private` — visible only to `owner`.
 */
export type ZoneVisibility = 'hidden' | 'public-top' | 'public' | 'private';

export type ZoneOwner = { kind: 'gm' } | { kind: 'player'; userId: UserId } | { kind: 'none' };

export interface ZoneDescriptor {
	id: string;
	deck: ZoneDeck;
	visibility: ZoneVisibility;
	/** Whether card position within the zone is meaningful (a pile with a top,
	 * or a procedure selection awaiting reorder) vs. an unordered collection
	 * (a hand, a public card area). */
	ordered: boolean;
	owner: ZoneOwner;
	cards: CardId[];
}

const NONE_OWNER: ZoneOwner = { kind: 'none' };
const GM_OWNER: ZoneOwner = { kind: 'gm' };

/** The well-known ids of the state's fixed (non-addressable-array) zones. */
export const FIXED_ZONE_IDS = {
	majorDraw: 'majorDraw',
	majorDiscard: 'majorDiscard',
	playerDraw: 'playerDraw',
	playerDiscard: 'playerDiscard',
	gmHand: 'gmHand'
} as const;

/** Flattens every zone in `state` — fixed and addressable — into one list of
 * normalized descriptors. */
export function listZoneDescriptors(state: SessionEngineStateV1): ZoneDescriptor[] {
	const descriptors: ZoneDescriptor[] = [
		{
			id: FIXED_ZONE_IDS.majorDraw,
			deck: 'major',
			visibility: 'hidden',
			ordered: true,
			owner: NONE_OWNER,
			cards: state.majorDraw
		},
		{
			id: FIXED_ZONE_IDS.majorDiscard,
			deck: 'major',
			visibility: 'public-top',
			ordered: true,
			owner: NONE_OWNER,
			cards: state.majorDiscard
		},
		{
			id: FIXED_ZONE_IDS.playerDraw,
			deck: 'player',
			visibility: 'hidden',
			ordered: true,
			owner: NONE_OWNER,
			cards: state.playerDraw
		},
		{
			id: FIXED_ZONE_IDS.playerDiscard,
			deck: 'player',
			visibility: 'public-top',
			ordered: true,
			owner: NONE_OWNER,
			cards: state.playerDiscard
		},
		{
			id: FIXED_ZONE_IDS.gmHand,
			deck: 'major',
			visibility: 'private',
			ordered: false,
			owner: GM_OWNER,
			cards: state.gmHand
		}
	];

	for (const zone of state.privateZones) {
		descriptors.push({
			id: zone.id,
			deck: 'player',
			visibility: 'private',
			ordered: false,
			owner: { kind: 'player', userId: zone.ownerUserId },
			cards: zone.cards
		});
	}

	for (const zone of state.publicZones) {
		descriptors.push({
			id: zone.id,
			// `initiative`/`played`/`revealed` are genuinely mixed zones — the GM
			// plays major-deck cards and players play player-deck cards into the
			// same public area (spec §8.2). `inspiration` is player-deck only:
			// High Chant distributes inspiration from the player discard (spec
			// §8.7), so it is deck-checked like any single-deck zone.
			deck: zone.kind === 'inspiration' ? 'player' : 'both',
			visibility: 'public',
			ordered: zone.kind === 'initiative',
			owner: NONE_OWNER,
			cards: zone.cards
		});
	}

	for (const zone of state.pendingZones) {
		descriptors.push({
			id: zone.id,
			deck: zone.deck,
			visibility: 'hidden',
			ordered: true,
			owner: NONE_OWNER,
			cards: zone.cards
		});
	}

	return descriptors;
}
