/**
 * Role-scoped allowlist projections of `SessionEngineStateV1` (spec §8.2).
 * `projectForActor` builds a brand-new object and copies only approved
 * fields onto it — it never clones full state and deletes secrets, so a
 * missed field fails closed (absent) rather than leaking. Pure — no
 * UI/DB/network imports (see `tests/unit/session/import-boundaries.test.ts`).
 */

import type {
	CardId,
	CardSlot,
	HiddenCardSlot,
	OwnedPrivateZone,
	PublicPrivateZoneCardBacks,
	PublicSessionZoneView,
	SessionActor,
	SessionEngineStateV1,
	SessionGmProjection,
	SessionPlayerProjection,
	SessionPublicProjection,
	TarotCardCatalog,
	UserId,
	VisibleCardSlot
} from '$lib/types/session';
import { legalCommandsForActor } from './reducer';

export type SessionProjection = SessionPlayerProjection | SessionGmProjection;

/**
 * Task 4's runtime catalog (`compileSessionRuntimeContent` in
 * `$lib/server/content/session-runtime.ts`) hydrates each entry with real
 * label/imageKey/value and suit/rank-or-major metadata from the content
 * pack's tarot config. When present, that metadata is copied onto the
 * visible slot as-is. The engine's minimal test catalog (Task 1's deliberate
 * scope boundary — see `tests/fixtures/session.ts`) may carry only
 * `{id, deck}`; for those entries — or an id absent from the catalog
 * entirely — `label`/`imageKey` fall back to the card id and `value` falls
 * back to `0` rather than fabricating rulebook data the engine doesn't have.
 */
function hydrateVisible(cardId: CardId, catalog: TarotCardCatalog): VisibleCardSlot {
	const entry = catalog[cardId];
	const id = entry?.id ?? cardId;
	return {
		hidden: false,
		id,
		label: entry?.label ?? id,
		imageKey: entry?.imageKey ?? id,
		value: entry?.value ?? 0,
		...(entry?.suit !== undefined ? { suit: entry.suit } : {}),
		...(entry?.rank !== undefined ? { rank: entry.rank } : {}),
		...(entry?.major !== undefined ? { major: entry.major } : {})
	};
}

function visibleSlots(cardIds: readonly CardId[], catalog: TarotCardCatalog): CardSlot[] {
	return cardIds.map((id) => hydrateVisible(id, catalog));
}

function topSlot(cardIds: readonly CardId[], catalog: TarotCardCatalog): CardSlot | null {
	const top = cardIds[0];
	return top === undefined ? null : hydrateVisible(top, catalog);
}

function buildPublicZoneView(
	zone: { id: string; kind: PublicSessionZoneView['kind']; cards: CardId[] },
	catalog: TarotCardCatalog
): PublicSessionZoneView {
	return { id: zone.id, kind: zone.kind, cards: visibleSlots(zone.cards, catalog) };
}

function playerHandCounts(state: SessionEngineStateV1): Record<UserId, number> {
	const counts: Record<UserId, number> = {};
	for (const zone of state.privateZones) {
		if (zone.kind !== 'player-hand') continue;
		counts[zone.ownerUserId] = (counts[zone.ownerUserId] ?? 0) + zone.cards.length;
	}
	return counts;
}

function isCardBackZone(zone: OwnedPrivateZone): zone is OwnedPrivateZone & { kind: 'player-facedown' | 'player-prepared' } {
	return zone.kind === 'player-facedown' || zone.kind === 'player-prepared';
}

/**
 * The public "card-back projection" of every face-down/prepared zone (spec
 * §8.2) — one `HiddenCardSlot` per card, for every owner, always concealed
 * here regardless of who's viewing. This is what lets any participant see
 * *that* another player has N cards face-down without learning which cards;
 * the owner's own real identities come from `privateFacedown`/
 * `privatePrepared` on their own `SessionPlayerProjection`, not from here.
 */
function buildPrivateZoneCardBacks(state: SessionEngineStateV1): PublicPrivateZoneCardBacks[] {
	return state.privateZones.filter(isCardBackZone).map((zone) => ({
		id: zone.id,
		kind: zone.kind,
		ownerUserId: zone.ownerUserId,
		cards: zone.cards.map((): HiddenCardSlot => ({ hidden: true }))
	}));
}

function buildPublicProjection(state: SessionEngineStateV1, catalog: TarotCardCatalog): SessionPublicProjection {
	return {
		sessionId: state.sessionId,
		version: state.version,
		phase: state.phase,
		procedure: state.procedure
			? {
					procedureId: state.procedure.procedureId,
					stepIndex: state.procedure.stepIndex,
					pendingZoneIds: state.procedure.pendingZoneIds
				}
			: null,
		majorDrawCount: state.majorDraw.length,
		majorDiscardTop: topSlot(state.majorDiscard, catalog),
		playerDrawCount: state.playerDraw.length,
		playerDiscardTop: topSlot(state.playerDiscard, catalog),
		gmHandCount: state.gmHand.length,
		playerHandCounts: playerHandCounts(state),
		privateZoneCardBacks: buildPrivateZoneCardBacks(state),
		publicZones: state.publicZones.map((zone) => buildPublicZoneView(zone, catalog)),
		pendingZoneCounts: state.pendingZones.map((zone) => ({ id: zone.id, deck: zone.deck, count: zone.cards.length }))
	};
}

function ownedZoneCards(state: SessionEngineStateV1, ownerUserId: UserId, kind: string): CardId[] {
	return state.privateZones.filter((zone) => zone.ownerUserId === ownerUserId && zone.kind === kind).flatMap((zone) => zone.cards);
}

/**
 * Builds the projection `actor` is authorized to see: the shared public
 * view, plus only their own private identities (a player) or the GM hand
 * (a GM) — never a player's private identities, never a GM peek at a
 * player's hand beyond its count (spec §8.2). Every field below is an
 * explicit allowlist copy; nothing is cloned-then-deleted.
 *
 * `legalCommands` comes straight from `legalCommandsForActor` — the same
 * coarse, role-based authorization gate `reduceSession` itself checks first
 * — so a client renders controls from the engine's own answer, never a
 * client-side guess. It is deliberately coarse: it lists command *types* the
 * actor's role may attempt right now, not whether any specific zone/card
 * instance of that command would be legal (that still depends on the
 * command's own `sourceZoneId`/`cardId`/etc., which only `reduceSession`
 * can evaluate).
 */
export function projectForActor(state: SessionEngineStateV1, actor: SessionActor, catalog: TarotCardCatalog): SessionProjection {
	const publicProjection = buildPublicProjection(state, catalog);
	const legalCommands = legalCommandsForActor(actor);

	if (actor.kind === 'gm') {
		const gmProjection: SessionGmProjection = {
			public: publicProjection,
			gmHand: visibleSlots(state.gmHand, catalog),
			legalCommands
		};
		return gmProjection;
	}

	const playerProjection: SessionPlayerProjection = {
		public: publicProjection,
		privateHand: visibleSlots(ownedZoneCards(state, actor.userId, 'player-hand'), catalog),
		privateFacedown: visibleSlots(ownedZoneCards(state, actor.userId, 'player-facedown'), catalog),
		privatePrepared: visibleSlots(ownedZoneCards(state, actor.userId, 'player-prepared'), catalog),
		legalCommands
	};
	return playerProjection;
}
