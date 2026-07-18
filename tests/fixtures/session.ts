/**
 * Test fixtures for the shared tarot table session engine. Builds a valid,
 * freshly-dealt `SessionEngineStateV1` (all 78 configured cards split across
 * the major/player draw piles, every other zone empty) and a matching
 * `TarotCardCatalog`, both derived from the same placeholder content pack so
 * they can never drift apart.
 */

import { getContentPack } from '$lib/server/content/loader';
import { buildCardCatalogEntries, toCardCatalog } from '$lib/server/content/session-runtime';
import { buildMajorDeck, buildPlayerDeck, shuffleDeck, type TarotCard } from '$lib/engine/tarot-deck';
import type { CardId, SessionEngineStateV1, TarotCardCatalog, UserId } from '$lib/types/session';

function cardIds(cards: readonly TarotCard[]): string[] {
	return cards.map((card) => card.id);
}

/** The 78-card catalog (21 majors + 56 minors + the Fool) used by every
 * session fixture. */
export function makeSessionCatalogFixture(): TarotCardCatalog {
	const config = getContentPack().tarot;
	const catalog: TarotCardCatalog = {};
	for (const card of buildMajorDeck(config)) {
		catalog[card.id] = { id: card.id, deck: 'major' };
	}
	for (const card of buildPlayerDeck(config)) {
		catalog[card.id] = { id: card.id, deck: 'player' };
	}
	return catalog;
}

/**
 * The same 78-card catalog, but hydrated the way Task 4's
 * `compileSessionRuntimeContent` does — real label/imageKey/value and
 * suit/rank-or-major metadata per entry, via the same
 * `buildCardCatalogEntries`/`toCardCatalog` the server runtime compiler
 * uses. Use this (over `makeSessionCatalogFixture`) whenever a test needs to
 * assert that `hydrateVisible` reads real catalog metadata rather than
 * falling back to the card id.
 */
export function makeRichSessionCatalogFixture(): TarotCardCatalog {
	const config = getContentPack().tarot;
	return toCardCatalog(buildCardCatalogEntries(config));
}

/**
 * A valid session state: every configured card sits in the major or player
 * draw pile, all other zones are empty. Deterministic from `seed` so tests
 * are reproducible; pass distinct seeds to get distinct shuffles.
 */
export function makeSessionFixture(seed = 'session-fixture'): SessionEngineStateV1 {
	const config = getContentPack().tarot;
	const major = shuffleDeck(buildMajorDeck(config), `${seed}-major`);
	const player = shuffleDeck(buildPlayerDeck(config), `${seed}-player`);

	return {
		schemaVersion: 1,
		sessionId: 'session-fixture',
		version: 0,
		phase: 'crawl',
		procedure: null,
		majorDraw: cardIds(major),
		majorDiscard: [],
		playerDraw: cardIds(player),
		playerDiscard: [],
		gmHand: [],
		privateZones: [],
		publicZones: [],
		pendingZones: [],
		reshuffleAtBoundary: { major: false, player: false }
	};
}

/**
 * A session fixture with one private `player-hand` zone per entry of
 * `hands`, populated by pulling those exact card ids out of the shuffled
 * player draw pile (so the fixture's card count stays 78 and every id used
 * must be a real minor/Fool id — e.g. `'cups-i'`, `'swords-x'`). Zone ids are
 * `hand:<ownerUserId>`.
 */
export function fixtureWithHands(hands: Record<UserId, CardId[]>, seed = 'session-fixture'): SessionEngineStateV1 {
	const state = makeSessionFixture(seed);
	const playerDraw = state.playerDraw.slice();
	const privateZones = state.privateZones.slice();

	for (const [ownerUserId, cardIds] of Object.entries(hands)) {
		for (const cardId of cardIds) {
			const index = playerDraw.indexOf(cardId);
			if (index === -1) throw new Error(`fixtureWithHands: card not in player draw pile: ${cardId}`);
			playerDraw.splice(index, 1);
		}
		privateZones.push({ id: `hand:${ownerUserId}`, kind: 'player-hand', ownerUserId, cards: cardIds.slice() });
	}

	return { ...state, playerDraw, privateZones };
}
