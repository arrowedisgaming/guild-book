/**
 * Whole-state invariant checking for the shared tarot table. The pure
 * reducer (Task 2) calls `assertSessionInvariants` after every command so a
 * bug can never silently duplicate, drop, or misplace a card. Pure — no
 * UI/DB/network imports (see `tests/unit/session/import-boundaries.test.ts`).
 */

import type { SessionEngineStateV1, TarotCardCatalog } from '$lib/types/session';
import { listZoneDescriptors } from './zones';

export interface SessionInvariantErrorDetails {
	/** Zone ids involved — never a hidden card id. */
	zoneIds?: string[];
	/** Counts relevant to the failure (e.g. expected vs. found). */
	counts?: Record<string, number>;
}

/** Thrown by `assertSessionInvariants`. Deliberately carries only zone ids
 * and counts — never a hidden card id — so a caught error is always safe to
 * log or surface to a GM. */
export class SessionInvariantError extends Error {
	readonly zoneIds: string[];
	readonly counts?: Record<string, number>;

	constructor(message: string, details: SessionInvariantErrorDetails = {}) {
		super(message);
		this.name = 'SessionInvariantError';
		this.zoneIds = details.zoneIds ?? [];
		this.counts = details.counts;
	}
}

const PRIVATE_ZONE_KINDS = new Set(['player-hand', 'player-facedown', 'player-prepared']);
const PUBLIC_ZONE_KINDS = new Set(['initiative', 'played', 'revealed', 'inspiration']);

/**
 * Checks `state` against `catalog` (the configured card set) and throws a
 * `SessionInvariantError` on the first violation found. Checks, in order:
 *
 * 1. Zone ids are unique across every fixed/private/public/pending zone.
 * 2. Every private zone declares a non-empty owner.
 * 3. Every zone `kind` is one of its declared literal values.
 * 4. No card id occupies more than one zone (conservation).
 * 5. Every catalog card id is present somewhere (no card lost).
 * 6. No card id outside the catalog is present (no card invented).
 * 7. Every card lives in a zone of the deck the catalog assigns it to.
 * 8. `version` is a non-negative integer.
 * 9. An active procedure's `pendingZoneIds` all resolve to real pending zones.
 *
 * Returns `void`; throws on the first failure.
 */
export function assertSessionInvariants(state: SessionEngineStateV1, catalog: TarotCardCatalog): void {
	const zones = listZoneDescriptors(state);

	// 1. Zone id uniqueness.
	const zoneIdCounts = new Map<string, number>();
	for (const zone of zones) {
		zoneIdCounts.set(zone.id, (zoneIdCounts.get(zone.id) ?? 0) + 1);
	}
	const duplicateZoneIds = [...zoneIdCounts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
	if (duplicateZoneIds.length > 0) {
		throw new SessionInvariantError('duplicate zone id across session zones', { zoneIds: duplicateZoneIds });
	}

	// 2. Private zone ownership / recipient membership.
	for (const zone of state.privateZones) {
		if (!zone.ownerUserId || zone.ownerUserId.trim().length === 0) {
			throw new SessionInvariantError('private zone is missing a recipient owner', { zoneIds: [zone.id] });
		}
	}

	// 3. Zone visibility/kind legitimacy.
	for (const zone of state.privateZones) {
		if (!PRIVATE_ZONE_KINDS.has(zone.kind)) {
			throw new SessionInvariantError('private zone has an illegal kind', { zoneIds: [zone.id] });
		}
	}
	for (const zone of state.publicZones) {
		if (!PUBLIC_ZONE_KINDS.has(zone.kind)) {
			throw new SessionInvariantError('public zone has an illegal kind', { zoneIds: [zone.id] });
		}
	}

	// 4. Conservation: no card in more than one zone.
	const cardZoneIds = new Map<string, string[]>();
	for (const zone of zones) {
		for (const cardId of zone.cards) {
			const owners = cardZoneIds.get(cardId) ?? [];
			owners.push(zone.id);
			cardZoneIds.set(cardId, owners);
		}
	}
	const duplicatedInZones = new Set<string>();
	for (const owners of cardZoneIds.values()) {
		if (owners.length > 1) {
			for (const zoneId of owners) duplicatedInZones.add(zoneId);
		}
	}
	if (duplicatedInZones.size > 0) {
		throw new SessionInvariantError('duplicate card found across session zones', {
			zoneIds: [...duplicatedInZones]
		});
	}

	// 5. Catalog completeness: every configured card must be present.
	const catalogIds = Object.keys(catalog);
	const presentIds = new Set(cardZoneIds.keys());
	const missingCount = catalogIds.filter((id) => !presentIds.has(id)).length;
	if (missingCount > 0) {
		throw new SessionInvariantError(
			`missing card: expected ${catalogIds.length} configured cards, found ${presentIds.size}`,
			{ counts: { expected: catalogIds.length, found: presentIds.size } }
		);
	}

	// 6. No card outside the catalog.
	const unknownZoneIds = new Set<string>();
	for (const [cardId, owners] of cardZoneIds) {
		if (!(cardId in catalog)) {
			for (const zoneId of owners) unknownZoneIds.add(zoneId);
		}
	}
	if (unknownZoneIds.size > 0) {
		throw new SessionInvariantError('unrecognized card id not present in the card catalog', {
			zoneIds: [...unknownZoneIds]
		});
	}

	// 7. Deck ownership: a card may only occupy zones of its assigned deck.
	for (const zone of zones) {
		if (zone.deck === 'any') continue;
		for (const cardId of zone.cards) {
			const entry = catalog[cardId];
			if (entry.deck !== zone.deck) {
				throw new SessionInvariantError('card placed in a zone of the wrong deck', { zoneIds: [zone.id] });
			}
		}
	}

	// 8. Version sanity.
	if (!Number.isInteger(state.version) || state.version < 0) {
		throw new SessionInvariantError('session version must be a non-negative integer', {
			counts: { version: state.version }
		});
	}

	// 9. Procedure-owned pending zone references.
	if (state.procedure) {
		const pendingZoneIds = new Set(state.pendingZones.map((zone) => zone.id));
		const unresolved = state.procedure.pendingZoneIds.filter((id) => !pendingZoneIds.has(id));
		if (unresolved.length > 0) {
			throw new SessionInvariantError('procedure references an unknown pending zone', {
				zoneIds: unresolved
			});
		}
	}
}
