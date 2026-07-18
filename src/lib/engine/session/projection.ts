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

export type SessionProjection = SessionPlayerProjection | SessionGmProjection;

/**
 * Task 2's `catalog` is the minimal `{id, deck}` shape (Task 1's deliberate
 * scope boundary — Task 4 builds the full runtime catalog with real
 * labels/art/suit/rank/major metadata). A visible slot's `label`/`imageKey`
 * fall back to the card id and `value` is `0` rather than fabricating
 * rulebook data the engine doesn't have; `entry?.id` still consults the
 * catalog to confirm the id is genuinely configured.
 */
function hydrateVisible(cardId: CardId, catalog: TarotCardCatalog): VisibleCardSlot {
	const entry = catalog[cardId];
	const id = entry?.id ?? cardId;
	return { hidden: false, id, label: id, imageKey: id, value: 0 };
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

function buildPublicProjection(state: SessionEngineStateV1, catalog: TarotCardCatalog): SessionPublicProjection {
	return {
		sessionId: state.sessionId,
		version: state.version,
		phase: state.phase,
		// The pure engine only ever runs against an active session; lifecycle
		// status (frozen/ended) lives outside `SessionEngineStateV1`, tracked
		// by the command service (Task 5), which overwrites this field when
		// assembling the outer `SessionProjectionEnvelope`.
		status: 'active',
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
 */
export function projectForActor(state: SessionEngineStateV1, actor: SessionActor, catalog: TarotCardCatalog): SessionProjection {
	const publicProjection = buildPublicProjection(state, catalog);

	if (actor.kind === 'gm') {
		const gmProjection: SessionGmProjection = {
			public: publicProjection,
			gmHand: visibleSlots(state.gmHand, catalog)
		};
		return gmProjection;
	}

	const playerProjection: SessionPlayerProjection = {
		public: publicProjection,
		privateHand: visibleSlots(ownedZoneCards(state, actor.userId, 'player-hand'), catalog),
		privateFacedown: visibleSlots(ownedZoneCards(state, actor.userId, 'player-facedown'), catalog),
		privatePrepared: visibleSlots(ownedZoneCards(state, actor.userId, 'player-prepared'), catalog)
	};
	return playerProjection;
}
