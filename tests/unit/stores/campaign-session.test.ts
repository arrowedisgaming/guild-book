import { afterEach, describe, expect, it, vi } from 'vitest';
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
const recipientUserId = 'player-a';

function makeInitialSnapshot(sessionVersion: number): SessionSyncSnapshot {
	return {
		recipientUserId,
		cursor: 5,
		events: [],
		session: {
			sessionId: 'session-1',
			status: 'active',
			sessionVersion,
			campaignCursor: 5,
			projection: emptyProjection,
			challengeProjection: null,
			challengeLegalCommands: [],
			guidedTestProjection: null,
			guidedTestLegalCommands: [],
			campProjection: null,
			campLegalCommands: [],
			finiteProjection: null,
			finiteLegalCommands: []
		}
	};
}

function installBrowserHarness() {
	let visibilityState: DocumentVisibilityState = 'visible';
	const documentTarget = new EventTarget();
	Object.defineProperty(documentTarget, 'visibilityState', {
		get: () => visibilityState
	});
	const windowTarget = new EventTarget();
	const navigatorState = { onLine: true };
	vi.stubGlobal('document', documentTarget);
	vi.stubGlobal('window', windowTarget);
	vi.stubGlobal('navigator', navigatorState);
	return {
		documentTarget,
		windowTarget,
		navigatorState,
		setVisibility(next: DocumentVisibilityState) {
			visibilityState = next;
		}
	};
}

describe('createCampaignSessionStore', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('rejects an initial projection bound to a different recipient', () => {
		expect(() =>
			createCampaignSessionStore(
				'campaign-1',
				{ ...makeInitialSnapshot(1), recipientUserId: 'player-b' },
				{ recipientUserId }
			)
		).toThrow('Unable to refresh the campaign table');
	});

	it('discards a command projection bound to a different recipient', async () => {
		const initial = makeInitialSnapshot(1);
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
			jsonResponse(200, {
				recipientUserId: 'player-b',
				outcome: { ok: true },
				projection: { campaignCursor: 99, sessionVersion: 99, projection: emptyProjection }
			})
		);
		const store = createCampaignSessionStore('campaign-1', initial, {
			recipientUserId,
			fetchImpl
		});

		await expect(store.sendCommand({ type: 'end-round' })).resolves.toEqual({
			ok: false,
			message: 'That action could not be completed'
		});
		expect(store.snapshot).toEqual(initial);
	});

	it('registers and removes each browser lifecycle listener exactly once', () => {
		vi.useFakeTimers();
		const { documentTarget, windowTarget } = installBrowserHarness();

		const addDocumentListener = vi.spyOn(documentTarget, 'addEventListener');
		const removeDocumentListener = vi.spyOn(documentTarget, 'removeEventListener');
		const addWindowListener = vi.spyOn(windowTarget, 'addEventListener');
		const removeWindowListener = vi.spyOn(windowTarget, 'removeEventListener');
		const store = createCampaignSessionStore('campaign-1', makeInitialSnapshot(1), {
			recipientUserId,
			fetchImpl: vi.fn<typeof fetch>()
		});

		store.start();
		expect(addDocumentListener.mock.calls.map(([type]) => type)).toEqual(['visibilitychange']);
		expect(addWindowListener.mock.calls.map(([type]) => type)).toEqual([
			'focus',
			'online',
			'offline'
		]);

		store.stop();
		expect(removeDocumentListener.mock.calls.map(([type]) => type)).toEqual(['visibilitychange']);
		expect(removeWindowListener.mock.calls.map(([type]) => type)).toEqual([
			'focus',
			'online',
			'offline'
		]);
	});

	it('polls only while visible and refreshes immediately after visibility, focus, and online events', async () => {
		vi.useFakeTimers();
		const browser = installBrowserHarness();
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
		const store = createCampaignSessionStore('campaign-1', makeInitialSnapshot(1), {
			recipientUserId,
			intervalMs: 1000,
			jitterMs: 0,
			fetchImpl
		});

		store.start();
		expect(fetchImpl).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1000);
		expect(fetchImpl).toHaveBeenCalledTimes(1);

		browser.setVisibility('hidden');
		browser.documentTarget.dispatchEvent(new Event('visibilitychange'));
		await vi.advanceTimersByTimeAsync(5000);
		expect(fetchImpl).toHaveBeenCalledTimes(1);

		browser.setVisibility('visible');
		browser.documentTarget.dispatchEvent(new Event('visibilitychange'));
		await vi.runAllTicks();
		expect(fetchImpl).toHaveBeenCalledTimes(2);

		browser.windowTarget.dispatchEvent(new Event('focus'));
		await vi.runAllTicks();
		expect(fetchImpl).toHaveBeenCalledTimes(3);

		browser.windowTarget.dispatchEvent(new Event('offline'));
		expect(store.online).toBe(false);
		browser.windowTarget.dispatchEvent(new Event('online'));
		await vi.runAllTicks();
		expect(store.online).toBe(true);
		expect(fetchImpl).toHaveBeenCalledTimes(4);
		store.stop();
	});

	it('aborts an in-flight poll when stopped', async () => {
		let observedSignal: AbortSignal | undefined;
		const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
			observedSignal = init?.signal ?? undefined;
			return new Promise<Response>(() => {});
		});
		const store = createCampaignSessionStore('campaign-1', makeInitialSnapshot(1), {
			recipientUserId,
			fetchImpl
		});

		void store.poll();
		await Promise.resolve();
		expect(observedSignal?.aborted).toBe(false);
		store.stop();
		expect(observedSignal?.aborted).toBe(true);
	});

	it('surfaces only the fixed sync error and clears it after recovery', async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response('SECRET SERVER DETAIL', { status: 500 }))
			.mockRejectedValueOnce(new Error('SECRET NETWORK DETAIL'))
			.mockResolvedValueOnce(new Response(null, { status: 204 }));
		const store = createCampaignSessionStore('campaign-1', makeInitialSnapshot(1), {
			recipientUserId,
			fetchImpl
		});

		await store.refreshNow();
		expect(store.error).toBe('Unable to refresh the campaign table');
		expect(store.error).not.toContain('SECRET');
		await store.refreshNow();
		expect(store.error).toBe('Unable to refresh the campaign table');
		await store.refreshNow();
		expect(store.error).toBeNull();
		store.stop();
	});

	it('deduplicates an identical in-flight command and sends its structural precondition once', async () => {
		const response = deferred<Response>();
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
			requests.push({ url: String(input), init });
			return response.promise;
		});
		const store = createCampaignSessionStore('campaign-1', makeInitialSnapshot(4), {
			recipientUserId,
			fetchImpl
		});

		const first = store.sendCommand({ type: 'end-round' }, 4);
		const second = store.sendCommand({ type: 'end-round' }, 4);
		expect(second).toBe(first);
		expect(requests).toHaveLength(1);
		expect(JSON.parse(String(requests[0].init?.body))).toMatchObject({
			observedSessionVersion: 4,
			expectedStructuralVersion: 4,
			command: { type: 'end-round' }
		});

		response.resolve(
			jsonResponse(200, {
				recipientUserId,
				outcome: { ok: true },
				projection: { campaignCursor: 6, sessionVersion: 5, projection: emptyProjection }
			})
		);
		await expect(first).resolves.toEqual({ ok: true });
		expect(store.session?.sessionVersion).toBe(5);
	});

	it('applies accepted specialized command projections to their matching slices', async () => {
		const responses = [
			{
				path: 'challenge-commands',
				body: {
					recipientUserId,
					outcome: { ok: true },
					projection: { campaignCursor: 6, sessionVersion: 2, projection: emptyProjection },
					challengeProjection: { stage: 'round-setup' },
					challengeLegalCommands: ['begin-challenge']
				}
			},
			{
				path: 'guided-test-commands',
				body: {
					recipientUserId,
					outcome: { ok: true },
					projection: { campaignCursor: 7, sessionVersion: 3, projection: emptyProjection },
					guidedTestProjection: { kind: 'single' },
					guidedTestLegalCommands: ['call-test']
				}
			},
			{
				path: 'camp-commands',
				body: {
					recipientUserId,
					outcome: { ok: true },
					projection: { campaignCursor: 8, sessionVersion: 4, projection: emptyProjection },
					campProjection: { procedureId: 'high-chant' },
					campLegalCommands: ['begin-high-chant']
				}
			},
			{
				path: 'correction-commands',
				body: {
					recipientUserId,
					outcome: { ok: true },
					projection: { campaignCursor: 9, sessionVersion: 5, projection: emptyProjection }
				}
			},
			{
				path: 'finite-commands',
				body: {
					recipientUserId,
					outcome: { ok: true },
					projection: { campaignCursor: 10, sessionVersion: 6, projection: emptyProjection },
					finiteProjection: { procedureId: 'crawl' },
					finiteLegalCommands: ['begin-procedure']
				}
			}
		];
		const seenPaths: string[] = [];
		const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
			const next = responses.shift();
			if (!next) throw new Error('unexpected request');
			seenPaths.push(String(input));
			return jsonResponse(200, next.body);
		});
		const store = createCampaignSessionStore('campaign-1', makeInitialSnapshot(1), {
			recipientUserId,
			fetchImpl
		});

		await expect(store.sendChallengeCommand({ type: 'begin-challenge' } as never)).resolves.toEqual({ ok: true });
		await expect(store.sendGuidedTestCommand({ type: 'call-test' } as never)).resolves.toEqual({ ok: true });
		await expect(store.sendCampCommand({ type: 'begin-high-chant' } as never)).resolves.toEqual({ ok: true });
		await expect(store.sendCorrectionCommand({ type: 'correct' })).resolves.toEqual({ ok: true });
		await expect(store.sendFiniteCommand({ type: 'begin-procedure' } as never)).resolves.toEqual({ ok: true });

		expect(seenPaths.map((url) => url.split('/').at(-1))).toEqual([
			'challenge-commands',
			'guided-test-commands',
			'camp-commands',
			'correction-commands',
			'finite-commands'
		]);
		expect(store.session?.sessionVersion).toBe(6);
		expect(store.session?.challengeLegalCommands).toEqual(['begin-challenge']);
		expect(store.session?.guidedTestLegalCommands).toEqual(['call-test']);
		expect(store.session?.campLegalCommands).toEqual(['begin-high-chant']);
		expect(store.session?.finiteLegalCommands).toEqual(['begin-procedure']);
	});

	it('applies lifecycle transitions and removes an ended session', async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				jsonResponse(200, {
					recipientUserId,
					success: true,
					action: 'freeze',
					session: { campaignCursor: 6, sessionVersion: 2, projection: emptyProjection }
				})
			)
			.mockResolvedValueOnce(
				jsonResponse(200, { recipientUserId, success: true, action: 'end', session: null })
			);
		const store = createCampaignSessionStore('campaign-1', makeInitialSnapshot(1), {
			recipientUserId,
			fetchImpl
		});

		await expect(store.sendLifecycleAction('freeze')).resolves.toEqual({ ok: true });
		expect(store.session?.status).toBe('frozen');
		expect(store.session?.sessionVersion).toBe(2);
		await expect(store.sendLifecycleAction('end')).resolves.toEqual({ ok: true });
		expect(store.session).toBeNull();
	});

	it('never lets a slower poll response regress a session version a faster command response already applied', async () => {
		const getDeferred = deferred<Response>();
		const postDeferred = deferred<Response>();

		const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === 'string' ? input : input.toString();
			if (init?.method === 'POST') return postDeferred.promise;
			if (url.includes('/sync')) return getDeferred.promise;
			throw new Error(`unexpected fetch in test: ${url}`);
		}) as typeof fetch;

		const store = createCampaignSessionStore('campaign-1', makeInitialSnapshot(1), {
			fetchImpl,
			recipientUserId
		});

		// Both requests are in flight before either settles — mirrors a poll
		// that was already on the wire when a command was sent.
		const pollPromise = store.poll();
		const commandPromise = store.sendCommand({ type: 'end-round' }, 1);

		// The command's POST resolves FIRST: the fresher write lands.
		postDeferred.resolve(
			jsonResponse(200, {
				recipientUserId,
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
				recipientUserId,
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
			recipientUserId,
			fetchImpl: async () =>
				jsonResponse(200, {
					recipientUserId,
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
			recipientUserId,
			fetchImpl: async () =>
				jsonResponse(200, { recipientUserId, cursor: 11, events: [], session: null })
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
					recipientUserId,
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

		const store = createCampaignSessionStore('campaign-1', makeInitialSnapshot(1), {
			fetchImpl,
			recipientUserId
		});

		const commandPromise = store.sendCommand({ type: 'end-round' }, 1);
		// A poll started after the command lands first, jumping the session
		// ahead to version 5.
		await store.poll();
		expect(store.session?.sessionVersion).toBe(5);

		// The slow command response now resolves, reflecting a commit that
		// only reached version 2 — older than what the poll already applied.
		postDeferred.resolve(
			jsonResponse(200, {
				recipientUserId,
				outcome: { ok: true, resultingVersion: 2 },
				projection: { campaignCursor: 6, sessionVersion: 2, projection: emptyProjection }
			})
		);
		await commandPromise;

		expect(store.session?.sessionVersion).toBe(5);
	});

	it('discards an entire sync response addressed to another recipient', async () => {
		const safeSnapshot = makeInitialSnapshot(2);
		const store = createCampaignSessionStore('campaign-1', safeSnapshot, {
			recipientUserId,
			fetchImpl: async () =>
				jsonResponse(200, {
					recipientUserId: 'player-b',
					cursor: 99,
					events: [
						{
							id: 99,
							sessionId: 'session-1',
							kind: 'private-card-event',
							publicPayload: {},
							privatePayload: { cardLabel: 'PLAYER B PRIVATE CARD' }
						}
					],
					session: {
						sessionId: 'session-1',
						status: 'active',
						sessionVersion: 50,
						campaignCursor: 99,
						projection: emptyProjection,
						challengeProjection: null,
						challengeLegalCommands: [],
						guidedTestProjection: null,
						guidedTestLegalCommands: [],
						campProjection: null,
						campLegalCommands: [],
						finiteProjection: null,
						finiteLegalCommands: []
					}
				})
		});

		await expect(store.poll()).rejects.toThrow('Unable to refresh the campaign table');
		expect(store.snapshot).toEqual(safeSnapshot);
	});
});
