/**
 * Response-shaping helpers for the Task 6 session HTTP surface: numeric
 * query-param validation, the events-per-response cap (controller amendment
 * 7), merging a public event row with only the authenticated recipient's own
 * secret payload, and the Task 5 rejection-code → HTTP-status mapping
 * (controller amendment 2). Owns exactly one concern — turning
 * repository/service-layer data into a safe wire shape — never decides auth
 * or session business rules itself; routes still own response bodies and
 * messages.
 */

import { error } from '@sveltejs/kit';
import type { CampaignEventRow } from './repository';

/** Hard cap on events returned per `/sync` response (amendment 7) — large
 * enough to cover a realistic burst of table activity between polls, small
 * enough to bound response size and D1 read cost. A client below this cursor
 * simply polls again with the returned (lower) cursor to keep catching up. */
export const MAX_EVENTS_PER_RESPONSE = 200;

export interface WireSessionEvent {
	id: number;
	sessionId: string | null;
	kind: string;
	publicPayload: unknown;
	privatePayload?: unknown;
}

/**
 * Parses a required non-negative-integer query parameter (`after`/`version`),
 * throwing SvelteKit's `error(400, ...)` — missing, non-numeric, negative,
 * fractional, or out of safe-integer range are all rejected before any
 * cursor ever reaches a query. Callers wrap this in the route (not here) so
 * the thrown error's status flows through SvelteKit's ordinary handling.
 */
export function parseNonNegativeIntParam(rawValue: string | null, paramName: string): number {
	if (rawValue === null || rawValue.trim() === '') {
		throw error(400, `"${paramName}" is required`);
	}
	if (!/^\d+$/.test(rawValue.trim())) {
		throw error(400, `"${paramName}" must be a non-negative integer`);
	}
	const value = Number(rawValue);
	if (!Number.isSafeInteger(value)) {
		throw error(400, `"${paramName}" is out of range`);
	}
	return value;
}

/** Caps `rows` (already ordered ascending by id) at `MAX_EVENTS_PER_RESPONSE`,
 * oldest-first — the client's next poll picks up where this response's last
 * returned id left off. */
export function capEventRows<T>(rows: readonly T[]): { rows: T[]; truncated: boolean } {
	if (rows.length <= MAX_EVENTS_PER_RESPONSE) return { rows: rows.slice(), truncated: false };
	return { rows: rows.slice(0, MAX_EVENTS_PER_RESPONSE), truncated: true };
}

/**
 * Merges one public event row with `recipientUserId`'s own secret payload,
 * if any — never another recipient's. `secretsByEventId` must already be
 * scoped to a single recipient (see `repository.ts`'s
 * `listEventSecretsForRecipient`), so this function has no way to leak
 * anyone else's payload even if misused.
 */
export function toWireEvent(row: CampaignEventRow, secretsByEventId: ReadonlyMap<number, unknown>): WireSessionEvent {
	const wire: WireSessionEvent = {
		id: row.id,
		sessionId: row.sessionId,
		kind: row.kind,
		publicPayload: row.publicPayload
	};
	const privatePayload = secretsByEventId.get(row.id);
	if (privatePayload !== undefined) wire.privatePayload = privatePayload;
	return wire;
}

/** Every rejection code Task 5's session/lifecycle services can return. */
export type SessionRejectionHttpCode =
	| 'not-authorized'
	| 'illegal-command'
	| 'stale-structure'
	| 'command-id-reused'
	| 'content-mismatch'
	| 'retry-exhausted';

/**
 * Maps a Task 5 rejection code to its HTTP status per controller amendment
 * 2 — `not-authorized` denial is indistinguishable from nonexistence (404);
 * `illegal-command`/`content-mismatch`/envelope-parse-failure are client
 * errors (400); `stale-structure`/`retry-exhausted`/`command-id-reused` are
 * retryable conflicts (409). Pure: callers still own the response body/
 * message so every route applies the identical mapping without duplicating
 * the switch itself.
 */
export function rejectionStatus(code: SessionRejectionHttpCode): 404 | 400 | 409 {
	switch (code) {
		case 'not-authorized':
			return 404;
		case 'illegal-command':
		case 'content-mismatch':
			return 400;
		case 'stale-structure':
		case 'retry-exhausted':
		case 'command-id-reused':
			return 409;
	}
}
