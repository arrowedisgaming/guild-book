/**
 * Test fixtures for the shared tarot table session engine. Builds a valid,
 * freshly-dealt `SessionEngineStateV1` (all 78 configured cards split across
 * the major/player draw piles, every other zone empty) and a matching
 * `TarotCardCatalog`, both derived from the same placeholder content pack so
 * they can never drift apart.
 */

import { getContentPack } from '$lib/server/content/loader';
import { buildMajorDeck, buildPlayerDeck, shuffleDeck, type TarotCard } from '$lib/engine/tarot-deck';
import type { SessionEngineStateV1, TarotCardCatalog } from '$lib/types/session';

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
