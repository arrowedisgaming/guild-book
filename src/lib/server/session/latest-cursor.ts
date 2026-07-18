/**
 * Isolate-local, advisory-only cursor hints for `/sync` (controller
 * amendment 6). A bounded, per-process `Map` — never authority, never
 * consulted before authorization, and never a substitute for the D1
 * cursor/version read when a hint is missing, stale, or in any way
 * uncertain. Purely an optimization so a burst of identical no-change polls
 * against the same campaign doesn't each round-trip to D1.
 *
 * Correctness note: a hint tracks only the campaign event *cursor*, not the
 * session *version*, because every accepted session mutation this codebase
 * can produce — an in-band command's accepted events (`repository.ts`'s
 * `eventStatements`) and every lifecycle transition (`session-started`/
 * `session-frozen`/`session-recovered`/`session-ended`, all via
 * `conditionalCampaignEventInsertStatement`) — always inserts at least one
 * `campaign_events` row in the same atomic write that advances
 * `play_sessions.version`. An unchanged cursor therefore implies an
 * unchanged session version too; if that invariant is ever broken by a
 * future command type that mutates state without emitting an event, this
 * hint would need to start tracking version as well.
 */

/** Cap on distinct campaigns tracked at once, so a long-lived isolate
 * serving many campaigns can't grow this map without bound. */
const MAX_HINTS = 256;

/** How long a hint is trusted before falling back to D1 — short, matching
 * the ~1s table-polling cadence (spec §10.3), so a hint reused across a poll
 * or two is at most this stale. */
const HINT_FRESH_MS = 2_000;

interface CursorHint {
	cursor: number;
	observedAt: number;
}

const hints = new Map<string, CursorHint>();

/**
 * True only when a hint exists for `campaignId`, is still fresh, and
 * matches the caller's own `after` cursor exactly — the one case where
 * "nothing changed" can be answered without a D1 read. Callers must only
 * invoke this after authorization has already been checked (amendment 6).
 */
export function hasFreshMatchingCursorHint(campaignId: string, callerCursor: number, now = Date.now()): boolean {
	const hint = hints.get(campaignId);
	if (!hint) return false;
	if (now - hint.observedAt > HINT_FRESH_MS) return false;
	return hint.cursor === callerCursor;
}

/**
 * Records the campaign's freshly-confirmed cursor — only ever after a
 * successful commit or a confirmed D1 read, never speculatively. Deleting
 * then re-inserting the key keeps a `Map`'s insertion order acting as a
 * simple recency order, so eviction below drops the least-recently-touched
 * campaign first (LRU-ish, not exact LRU).
 */
export function recordCursorHint(campaignId: string, cursor: number, now = Date.now()): void {
	hints.delete(campaignId);
	hints.set(campaignId, { cursor, observedAt: now });
	if (hints.size > MAX_HINTS) {
		const oldestKey = hints.keys().next().value;
		if (oldestKey !== undefined) hints.delete(oldestKey);
	}
}

/** Test-only: clears every hint so isolate-local state can't leak between
 * test cases that share this module's singleton `Map`. */
export function resetCursorHintsForTest(): void {
	hints.clear();
}
