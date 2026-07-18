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
 *
 * Fix round 1 (task-7 coordinator correction): every accepted-commit path in
 * `command-service.ts`/`lifecycle.ts` now calls `repository.ts`'s
 * `recordFreshCursorHintAfterCommit` right after its write lands, so a
 * same-isolate write can never leave a stale-but-still-"fresh" hint behind —
 * the hint is corrected the instant the write that would invalidate it
 * commits, not left to whenever some later `/sync` poll happens to do a real
 * read. `HINT_FRESH_MS` below therefore only has to bound the *cross-isolate*
 * case (a write lands on a different isolate than the one serving a given
 * poll — real on a multi-isolate platform like Cloudflare Workers/D1, the
 * production target; not applicable to the single-process dev/test server).
 *
 * Budget arithmetic for Task 7's two-second cross-client visibility bound
 * (spec Gate C): a client polls at most every `intervalMs + jitterMs` =
 * 1000 + 150 = 1150ms while visible (`campaign-session.svelte.ts`). Assume
 * up to ~150ms of request/response latency. A poll that lands just before a
 * cross-isolate write commits can miss it once; the very next poll, up to
 * 1150 + 150 = 1300ms later, must not be able to hit the same stale hint —
 * so `HINT_FRESH_MS` must be comfortably under that 1300ms remainder of the
 * 2000ms budget. 600ms leaves real margin.
 */

/** Cap on distinct campaigns tracked at once, so a long-lived isolate
 * serving many campaigns can't grow this map without bound. */
const MAX_HINTS = 256;

/** How long a hint is trusted before falling back to D1 — see the budget
 * arithmetic in this file's header comment. Short enough that even a
 * cross-isolate write, which this cache cannot see land, can delay visibility
 * by at most one missed poll and never a second one within the 2s bound. */
const HINT_FRESH_MS = 600;

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
