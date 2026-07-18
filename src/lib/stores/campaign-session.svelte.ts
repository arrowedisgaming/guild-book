/**
 * Client-side store for the shared tarot table (shared-tarot-table
 * increment, Task 7). Owns every fetch/poll/command concern for a live
 * session so components stay presentation-only:
 *
 *  - Polls `GET /api/campaigns/[id]/sync?after=&version=` (controller
 *    amendment 1 — root-relative, never the route-relative `events?since=`
 *    the original task-7 snippet used, which would resolve against
 *    `/campaigns/[id]/table` instead of the API) on a jittered ~1s cadence
 *    while the tab is visible, pauses while hidden, and refreshes
 *    immediately on focus/reconnect.
 *  - Schedules the next poll only after the previous one settles, and aborts
 *    an outstanding request on `stop()`.
 *  - Sends session commands with a client-generated `commandId`
 *    (`crypto.randomUUID()`); an identical command already in flight reuses
 *    the same in-flight promise/commandId rather than minting a second one,
 *    so a duplicate click or retry before the first settles applies exactly
 *    once (amendment 6). An accepted response replaces the local projection
 *    immediately — never waits for the next poll.
 *  - Every surfaced error is a fixed, generic string: never a server
 *    response body, never a card identity.
 *
 * `intervalMs` is configurable (default ~1s, the live-table cadence) so this
 * same store can back the campaign list/detail pages' slower ~5s cadence
 * later (amendment 5) without a second implementation — this task only
 * wires it into the table route itself; the dashboard pages are unchanged.
 */

import type { CardSlot, SessionCommand, SessionStatus } from '$lib/types/session';
import type { SessionProjection } from '$lib/engine/session/projection';
import type { DrawnCard } from '$lib/tarot/protocol';

export interface WireSessionEventLike {
	id: number;
	sessionId: string | null;
	kind: string;
	publicPayload: unknown;
	privatePayload?: unknown;
}

export interface TableSession {
	sessionId: string;
	status: SessionStatus;
	sessionVersion: number;
	campaignCursor: number;
	projection: SessionProjection;
}

export interface SessionSyncSnapshot {
	cursor: number;
	events: WireSessionEventLike[];
	session: TableSession | null;
}

export interface CampaignSessionStoreOptions {
	/** Base poll interval while visible, in ms. Defaults to the table's ~1s
	 * cadence. */
	intervalMs?: number;
	/** Max randomized jitter added on top of `intervalMs`, in ms. */
	jitterMs?: number;
	/** Test-only fetch override. */
	fetchImpl?: typeof fetch;
}

export interface SendCommandResult {
	ok: boolean;
	message?: string;
}

interface SyncResponseBody {
	cursor: number;
	events: WireSessionEventLike[];
	session: TableSession | null;
}

interface CommandResponseBody {
	outcome?: { ok: boolean };
	projection?: { campaignCursor: number; sessionVersion: number; projection: SessionProjection } | null;
}

const SYNC_ERROR_MESSAGE = 'Unable to refresh the campaign table';
const COMMAND_ERROR_MESSAGE = 'That action could not be completed';

export function createCampaignSessionStore(
	campaignId: string,
	initial: SessionSyncSnapshot,
	options: CampaignSessionStoreOptions = {}
) {
	const intervalMs = options.intervalMs ?? 1000;
	const jitterMs = options.jitterMs ?? 150;
	const doFetch = options.fetchImpl ?? fetch;

	let snapshot = $state(initial);
	let visible = $state(currentVisibility());
	let online = $state(currentOnline());
	let error = $state<string | null>(null);

	let timer: ReturnType<typeof setTimeout> | null = null;
	let controller: AbortController | null = null;
	let destroyed = false;

	/** Keyed by a canonical stringification of the command (+ its structural
	 * precondition) currently in flight — never by a random id, so a second
	 * call with the identical payload while the first hasn't settled reuses
	 * the same promise/commandId instead of issuing a second request. */
	const pending = new Map<string, Promise<SendCommandResult>>();

	function currentVisibility(): boolean {
		return typeof document === 'undefined' ? true : document.visibilityState === 'visible';
	}

	function currentOnline(): boolean {
		return typeof navigator === 'undefined' ? true : navigator.onLine;
	}

	/** One `/sync` request. Resolves normally on 204 (nothing changed) or a
	 * successful 200 (snapshot replaced). Throws a fixed, generic error on
	 * any other status — the response body is never read or surfaced. */
	async function poll(): Promise<void> {
		if (destroyed) return;
		controller?.abort();
		const attemptController = new AbortController();
		controller = attemptController;
		const version = snapshot.session?.sessionVersion ?? 0;
		const url = `/api/campaigns/${campaignId}/sync?after=${snapshot.cursor}&version=${version}`;

		const response = await doFetch(url, {
			headers: { Accept: 'application/json' },
			cache: 'no-store',
			signal: attemptController.signal
		});

		if (response.status === 204) {
			error = null;
			return;
		}
		if (!response.ok) throw new Error(SYNC_ERROR_MESSAGE);

		const body = (await response.json()) as SyncResponseBody;
		// Review round 2 fix: a poll started before a command's POST can
		// resolve *after* that command's response already replaced `session`
		// with a newer projection (sendCommand's optimistic update) — the
		// slower GET reflects state read before the write landed. Applying it
		// unconditionally would silently regress the visible session back to
		// stale data. Only the `session` field needs this guard: `cursor`/
		// `events` are always poll-owned (a command intentionally never
		// advances them — see `performSend`), so they always take the poll's
		// value.
		snapshot = {
			cursor: body.cursor,
			events: body.events,
			session: isOlderSessionVersion(snapshot.session?.sessionVersion, body.session?.sessionVersion)
				? snapshot.session
				: body.session
		};
		error = null;
	}

	async function tick(): Promise<void> {
		if (destroyed) return;
		try {
			await poll();
		} catch (cause) {
			if (!isAbortError(cause)) error = SYNC_ERROR_MESSAGE;
		}
		if (!destroyed && visible) scheduleNext();
	}

	function scheduleNext(): void {
		if (timer) clearTimeout(timer);
		const jitter = Math.random() * jitterMs;
		timer = setTimeout(() => void tick(), intervalMs + jitter);
	}

	function cancelSchedule(): void {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	}

	/** Bypasses the schedule and polls right now — used on `start()`, on
	 * regaining visibility/focus, and on reconnect. */
	async function refreshNow(): Promise<void> {
		cancelSchedule();
		await tick();
	}

	function handleVisibilityChange(): void {
		visible = currentVisibility();
		if (visible) {
			void refreshNow();
		} else {
			cancelSchedule();
		}
	}

	function handleFocus(): void {
		if (!visible) return;
		void refreshNow();
	}

	function handleOnline(): void {
		online = true;
		void refreshNow();
	}

	function handleOffline(): void {
		online = false;
	}

	function start(): void {
		destroyed = false;
		if (typeof document !== 'undefined') {
			document.addEventListener('visibilitychange', handleVisibilityChange);
		}
		if (typeof window !== 'undefined') {
			window.addEventListener('focus', handleFocus);
			window.addEventListener('online', handleOnline);
			window.addEventListener('offline', handleOffline);
		}
		visible = currentVisibility();
		online = currentOnline();
		if (visible) scheduleNext();
	}

	function stop(): void {
		destroyed = true;
		cancelSchedule();
		controller?.abort();
		if (typeof document !== 'undefined') {
			document.removeEventListener('visibilitychange', handleVisibilityChange);
		}
		if (typeof window !== 'undefined') {
			window.removeEventListener('focus', handleFocus);
			window.removeEventListener('online', handleOnline);
			window.removeEventListener('offline', handleOffline);
		}
	}

	function sendCommand(command: SessionCommand, expectedStructuralVersion?: number): Promise<SendCommandResult> {
		const session = snapshot.session;
		if (!session) return Promise.resolve({ ok: false, message: COMMAND_ERROR_MESSAGE });

		const key = canonicalCommandKey(command, expectedStructuralVersion);
		const inFlight = pending.get(key);
		if (inFlight) return inFlight;

		const commandId = randomCommandId();
		const promise = performSend(session.sessionId, commandId, command, expectedStructuralVersion).finally(() => {
			pending.delete(key);
		});
		pending.set(key, promise);
		return promise;
	}

	async function performSend(
		sessionId: string,
		commandId: string,
		command: SessionCommand,
		expectedStructuralVersion?: number
	): Promise<SendCommandResult> {
		const envelope = {
			commandId,
			observedSessionVersion: snapshot.session?.sessionVersion ?? 0,
			...(expectedStructuralVersion !== undefined ? { expectedStructuralVersion } : {}),
			command
		};

		try {
			const response = await doFetch(`/api/campaigns/${campaignId}/sessions/${sessionId}/commands`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
				cache: 'no-store',
				body: JSON.stringify(envelope)
			});
			const body = (await response.json().catch(() => null)) as CommandResponseBody | null;

			// Same-class race as `poll()` above, mirrored: a slow command
			// response can resolve after a poll (or another command) already
			// moved `session` forward, in which case this response reflects
			// state from before that later write — never regress past it.
			if (
				body?.projection &&
				snapshot.session &&
				snapshot.session.sessionId === sessionId &&
				!isOlderSessionVersion(snapshot.session.sessionVersion, body.projection.sessionVersion)
			) {
				snapshot = {
					...snapshot,
					session: {
						...snapshot.session,
						sessionVersion: body.projection.sessionVersion,
						campaignCursor: body.projection.campaignCursor,
						projection: body.projection.projection
					}
				};
			}

			if (!body?.outcome?.ok) return { ok: false, message: COMMAND_ERROR_MESSAGE };
			return { ok: true };
		} catch {
			return { ok: false, message: COMMAND_ERROR_MESSAGE };
		}
	}

	return {
		get snapshot() {
			return snapshot;
		},
		get session() {
			return snapshot.session;
		},
		get events() {
			return snapshot.events;
		},
		get visible() {
			return visible;
		},
		get online() {
			return online;
		},
		get error() {
			return error;
		},
		poll,
		sendCommand,
		refreshNow,
		start,
		stop
	};
}

function isAbortError(cause: unknown): boolean {
	return cause instanceof DOMException && cause.name === 'AbortError';
}

/**
 * True only when both a current and an incoming session version are known
 * and the incoming one is strictly behind — the one case an out-of-order
 * poll/command response must never be allowed to apply (review round 2).
 * An `undefined` version — no session known yet locally, or the incoming
 * response has none (the session ended, which is a one-way transition and
 * therefore never "stale" relative to any earlier live version) — always
 * lets the incoming value through.
 */
function isOlderSessionVersion(currentVersion: number | undefined, incomingVersion: number | undefined): boolean {
	return currentVersion !== undefined && incomingVersion !== undefined && incomingVersion < currentVersion;
}

function canonicalCommandKey(command: SessionCommand, expectedStructuralVersion?: number): string {
	return JSON.stringify({ command, expectedStructuralVersion });
}

function randomCommandId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
	return `cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export interface RenderableCard {
	faceDown: boolean;
	card: DrawnCard | null;
}

/** Maps a projection's `CardSlot` (own visible identity, or someone else's
 * `{hidden: true}` back) onto `TarotCard`'s props — hidden cards always get
 * `faceDown` and never a card object, by construction. */
export function renderableCard(slot: CardSlot | null | undefined): RenderableCard {
	if (!slot || slot.hidden) return { faceDown: true, card: null };
	return {
		faceDown: false,
		card: {
			id: slot.id,
			kind: slot.major ? 'major' : 'minor',
			label: slot.label,
			value: slot.value,
			suit: slot.suit,
			rank: slot.rank
		}
	};
}
