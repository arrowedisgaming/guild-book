/**
 * Doom-tier classification and predicates for the Challenge procedure (Ch7
 * `challenge-lesser-dooms` / `challenge-greater-dooms`). Pure — no
 * UI/DB/network imports (see `tests/unit/session/import-boundaries.test.ts`).
 *
 * The lesser/greater boundary (I-XIV vs XV-XXI) is NEVER a literal in this
 * module (Increment 3 Task 3 binding override O2) — it is read once, at
 * content-load time, from `tarot.doomTiers` by `tarot-deck.ts`'s
 * `toMajorCard`, and travels onto every major `TarotCardCatalogEntry.major`
 * (via `$lib/server/content/session-runtime.ts`'s compiler). `majorCardFrom`
 * below is therefore a lookup against the already-classified catalog, not a
 * calculation — this module never touches `tarot.doomTiers` itself.
 *
 * `cardMatchesDoomPredicate` and `DoomPredicate` are the typed vocabulary
 * content-backed denizen abilities (Increment 3 Task 4's typed modifiers)
 * compose against a played/discarded/revealed major card. Deciding what
 * happens when a predicate matches — and emitting `manual-consequence-
 * required` for whatever fictional effect the engine cannot model (health,
 * wounds, damage are never modeled here) — is Task 4's job, not this
 * module's or `turns.ts`'s (Increment 3 Task 3 scope boundary O6).
 */

import type { DoomTier, TarotCardCatalog, ValueParity } from '$lib/types/session';

/** The Doom-relevant slice of a major card's catalog metadata — mirrors
 * `TarotCardCatalogEntry.major` minus the display-only `number`/`name`
 * fields a predicate never needs. */
export interface MajorCard {
	doomTier?: DoomTier;
	valueParity: ValueParity;
}

/**
 * A typed condition a content-backed denizen ability can compose against a
 * major card, e.g. "this ability triggers on any greater doom" (`{tier:
 * 'greater', operation: 'play'}`) or "on an odd-valued lesser doom" (`{tier:
 * 'lesser', parity: 'odd', operation: 'reveal'}`). `count` is carried as
 * typed data for a predicate that cares how many matching cards were
 * involved (e.g. a threshold ability) — this module does not interpret it;
 * matching a single card is `cardMatchesDoomPredicate`'s whole job.
 */
export interface DoomPredicate {
	tier?: 'lesser' | 'greater';
	parity?: 'odd' | 'even';
	operation: 'play' | 'discard' | 'reveal';
	count?: number;
}

/** Whether `card` satisfies every field `predicate` constrains. An
 * `undefined` predicate field is unconstrained (matches anything); an absent
 * `card.doomTier` (the Fool, or a non-major card) never satisfies a
 * `tier`-constrained predicate, since `undefined !== 'lesser' | 'greater'`. */
export function cardMatchesDoomPredicate(card: MajorCard, predicate: DoomPredicate): boolean {
	return (
		(predicate.tier === undefined || card.doomTier === predicate.tier) &&
		(predicate.parity === undefined || card.valueParity === predicate.parity)
	);
}

/**
 * Looks up `cardId`'s Doom-relevant metadata from `catalog`. Returns
 * `undefined` only for a card with no `major` entry at all (every minor/
 * player-deck rank card) rather than fabricating one. The Fool DOES carry a
 * `major` entry (it is `kind: 'major'`, merely borrowed into the player deck
 * — `tarot-deck.ts`'s `buildFool`/`buildPlayerDeck`), so this returns a real
 * `MajorCard` for it — just one whose `doomTier` is `undefined`, which
 * already fails any `tier`-constrained `DoomPredicate` correctly (the Fool
 * is not a Doom card, per `toMajorCard`'s doc comment) without this function
 * needing a Fool-specific special case.
 */
export function majorCardFrom(catalog: TarotCardCatalog, cardId: string): MajorCard | undefined {
	const entry = catalog[cardId];
	if (!entry?.major) return undefined;
	return { doomTier: entry.major.doomTier, valueParity: entry.major.valueParity };
}
