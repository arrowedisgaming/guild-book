/**
 * Small read helpers over `SessionEngineStateV1`, built on top of the
 * normalized zone descriptors from `zones.ts`. Pure — no UI/DB/network
 * imports (see `tests/unit/session/import-boundaries.test.ts`).
 */

import type { CardId, SessionEngineStateV1 } from '$lib/types/session';
import { listZoneDescriptors, type ZoneDescriptor } from './zones';

/** Every card id currently in play across every zone, in no particular
 * order. May contain duplicates — invariant checking is `assertSessionInvariants`'s job, not this function's. */
export function allCardIds(state: SessionEngineStateV1): CardId[] {
	return listZoneDescriptors(state).flatMap((zone) => zone.cards);
}

/** Looks up a single zone's normalized descriptor by id, or `undefined` if
 * no zone in `state` has that id. */
export function findZoneDescriptor(state: SessionEngineStateV1, zoneId: string): ZoneDescriptor | undefined {
	return listZoneDescriptors(state).find((zone) => zone.id === zoneId);
}
