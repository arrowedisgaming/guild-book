import { describe, expect, it } from 'vitest';
import { createCampaignSessionStore, type SessionSyncSnapshot } from '$lib/stores/campaign-session.svelte';
import type { SessionProjection } from '$lib/engine/session/projection';

/**
 * Review round 2: the store is plain TS (well, a `.svelte.ts` runes module,
 * but `$state` reads/writes work fine outside a mounted component) — no
 * component/DOM needed, so the poll-vs-command interleaving race can be
 * driven directly with a controllable mocked `fetch`.
 */

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

const emptyProjection = { legalCommands: [] } as unknown as SessionProjection;

function makeInitialSnapshot(sessionVersion: number): SessionSyncSnapshot {
	return {
		cursor: 5,
		events: [],
		session: {
			sessionId: 'session-1',
			status: 'active',
			sessionVersion,
			campaignCursor: 5,
			projection: emptyProjection
		}
	};
}

describe('createCampaignSessionStore', () => {
	it('never lets a slower poll response regress a session version a faster command response already applied', async () => {
		const getDeferred = deferred<Response>();
		const postDeferred = deferred<Response>();

		const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === 'string' ? input : input.toString();
			if (init?.method === 'POST') return postDeferred.promise;
			if (url.includes('/sync')) return getDeferred.promise;
			throw new Error(`unexpected fetch in test: ${url}`);
		}) as typeof fetch;

		const store = createCampaignSessionStore('campaign-1', makeInitialSnapshot(1), { fetchImpl });

		// Both requests are in flight before either settles — mirrors a poll
		// that was already on the wire when a command was sent.
		const pollPromise = store.poll();
		const commandPromise = store.sendCommand({ type: 'end-round' }, 1);

		// The command's POST resolves FIRST: the fresher write lands.
		postDeferred.resolve(
			jsonResponse(200, {
				outcome: { ok: true, resultingVersion: 2 },
				projection: { campaignCursor: 6, sessionVersion: 2, projection: emptyProjection }
			})
		);
		await commandPromise;
		expect(store.session?.sessionVersion).toBe(2);

		// The poll's GET resolves SECOND, but its body reflects a read taken
		// *before* the command committed — an older session version than
		// what's already applied.
		getDeferred.resolve(
			jsonResponse(200, {
				cursor: 9,
				events: [{ id: 9, sessionId: 'session-1', kind: 'test-event', publicPayload: {} }],
				session: {
					sessionId: 'session-1',
					status: 'active',
					sessionVersion: 1,
					campaignCursor: 5,
					projection: emptyProjection
				}
			})
		);
		await pollPromise;

		// The session must not have regressed back to version 1.
		expect(store.session?.sessionVersion).toBe(2);
		// `cursor`/`events` are always poll-owned regardless of session
		// staleness, and must still have advanced from the poll response.
		expect(store.snapshot.cursor).toBe(9);
		expect(store.snapshot.events).toHaveLength(1);
	});

	it('applies a poll response whose session version is newer or equal, and always applies a session-ended (null) response', async () => {
		const store = createCampaignSessionStore('campaign-1', makeInitialSnapshot(2), {
			fetchImpl: async () =>
				jsonResponse(200, {
					cursor: 10,
					events: [],
					session: {
						sessionId: 'session-1',
						status: 'active',
						sessionVersion: 3,
						campaignCursor: 10,
						projection: emptyProjection
					}
				})
		});

		await store.poll();
		expect(store.session?.sessionVersion).toBe(3);

		const endedStore = createCampaignSessionStore('campaign-1', makeInitialSnapshot(3), {
			fetchImpl: async () => jsonResponse(200, { cursor: 11, events: [], session: null })
		});

		await endedStore.poll();
		expect(endedStore.session).toBeNull();
	});

	it('never lets a slower command response regress a session version a faster poll already applied', async () => {
		const postDeferred = deferred<Response>();

		const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === 'string' ? input : input.toString();
			if (init?.method === 'POST') return postDeferred.promise;
			if (url.includes('/sync')) {
				return jsonResponse(200, {
					cursor: 9,
					events: [],
					session: {
						sessionId: 'session-1',
						status: 'active',
						sessionVersion: 5,
						campaignCursor: 9,
						projection: emptyProjection
					}
				});
			}
			throw new Error(`unexpected fetch in test: ${url}`);
		}) as typeof fetch;

		const store = createCampaignSessionStore('campaign-1', makeInitialSnapshot(1), { fetchImpl });

		const commandPromise = store.sendCommand({ type: 'end-round' }, 1);
		// A poll started after the command lands first, jumping the session
		// ahead to version 5.
		await store.poll();
		expect(store.session?.sessionVersion).toBe(5);

		// The slow command response now resolves, reflecting a commit that
		// only reached version 2 — older than what the poll already applied.
		postDeferred.resolve(
			jsonResponse(200, {
				outcome: { ok: true, resultingVersion: 2 },
				projection: { campaignCursor: 6, sessionVersion: 2, projection: emptyProjection }
			})
		);
		await commandPromise;

		expect(store.session?.sessionVersion).toBe(5);
	});
});
