import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	CAMPAIGN_RATE_LIMIT_POLICIES,
	classifyCampaignRequest,
	createCampaignRateLimitHandle,
	readDegradedPollCount,
	resetRateLimitCountersForTest
} from '$lib/server/rate-limit/campaign';

/**
 * Increment 5 Task 1 — request-level behaviour of the shared limiter as it is
 * actually installed: a SvelteKit handle that classifies the request, keys the
 * bucket from the authenticated actor (falling back to the client address),
 * and answers with `Retry-After` without disclosing whether the campaign in
 * the path exists.
 */

const CAMPAIGN = 'camp-one';
const OTHER_CAMPAIGN = 'camp-two';

type FakeEventOptions = {
	path: string;
	method?: string;
	userId?: string | null;
	clientAddress?: string;
	platformEnv?: Record<string, unknown> | null;
	nodeEnv?: string;
};

function fakeEvent(options: FakeEventOptions) {
	const url = new URL(`http://localhost${options.path}`);
	return {
		url,
		request: new Request(url, { method: options.method ?? 'GET' }),
		getClientAddress: () => options.clientAddress ?? '203.0.113.7',
		// No `platform` unless a test explicitly simulates the edge: a request
		// with a platform env and no binding is the fail-closed case, not the
		// ordinary one.
		platform: options.platformEnv ? { env: options.platformEnv } : undefined,
		locals: {}
	};
}

function makeHandle(options: { userId?: string | null; nodeEnv?: string } = {}) {
	return createCampaignRateLimitHandle({
		getUserId: async () => (options.userId === undefined ? 'user-alpha' : options.userId),
		getEnv: (_event, key) => (key === 'NODE_ENV' ? (options.nodeEnv ?? 'production') : undefined)
	});
}

const resolve = vi.fn(async () => new Response('ok', { status: 200 }));

describe('request classification', () => {
	it('recognises every campaign policy from the real route paths', () => {
		expect(classifyCampaignRequest(`/api/campaigns/${CAMPAIGN}/sync`, 'GET')).toEqual({
			policy: 'session-poll',
			campaignId: CAMPAIGN
		});
		expect(
			classifyCampaignRequest(`/api/campaigns/${CAMPAIGN}/sessions/s-1/commands`, 'POST')
		).toEqual({ policy: 'session-command', campaignId: CAMPAIGN });
		expect(
			classifyCampaignRequest(`/api/campaigns/${CAMPAIGN}/sessions/s-1/challenge-commands`, 'POST')
		).toEqual({ policy: 'session-command', campaignId: CAMPAIGN });
		expect(classifyCampaignRequest('/api/campaigns/join/some-token', 'POST')).toEqual({
			policy: 'join-attempt'
		});
		expect(classifyCampaignRequest('/api/campaigns', 'POST')).toEqual({
			policy: 'campaign-mutation'
		});
		expect(classifyCampaignRequest(`/api/campaigns/${CAMPAIGN}/invite`, 'POST')).toEqual({
			policy: 'campaign-mutation',
			campaignId: CAMPAIGN
		});
	});

	it('leaves non-campaign and cheap campaign reads unclassified', () => {
		expect(classifyCampaignRequest('/api/characters/abc', 'PUT')).toBeNull();
		expect(classifyCampaignRequest('/api/denizens', 'GET')).toBeNull();
		expect(classifyCampaignRequest(`/api/campaigns/${CAMPAIGN}`, 'GET')).toBeNull();
		expect(classifyCampaignRequest('/campaigns/camp-one/table', 'GET')).toBeNull();
	});

	it('does not classify a join token as a campaign id', () => {
		// `/api/campaigns/join/<token>` must never be read as campaign `join`,
		// or every invite attempt in the world would share one bucket.
		expect(classifyCampaignRequest('/api/campaigns/join/tok', 'POST')?.campaignId).toBeUndefined();
	});
});

describe('campaign rate-limit handle', () => {
	beforeEach(() => {
		resetRateLimitCountersForTest();
		resolve.mockClear();
	});

	it('passes unrelated requests straight through', async () => {
		const handle = makeHandle();
		const response = await handle({ event: fakeEvent({ path: '/api/characters/abc', method: 'PUT' }) as never, resolve } as never);
		expect(response.status).toBe(200);
		expect(resolve).toHaveBeenCalledOnce();
	});

	it('answers 429 with Retry-After once a policy is exhausted', async () => {
		const handle = makeHandle();
		const limit = CAMPAIGN_RATE_LIMIT_POLICIES['campaign-mutation'].limit;
		const event = () => fakeEvent({ path: '/api/campaigns', method: 'POST' }) as never;

		for (let i = 0; i < limit; i++) {
			expect((await handle({ event: event(), resolve } as never)).status).toBe(200);
		}

		const denied = await handle({ event: event(), resolve } as never);
		expect(denied.status).toBe(429);
		expect(Number(denied.headers.get('Retry-After'))).toBeGreaterThan(0);
	});

	it('does not disclose the campaign or the actor in a denial', async () => {
		const handle = makeHandle();
		const limit = CAMPAIGN_RATE_LIMIT_POLICIES['session-command'].limit;
		const event = () =>
			fakeEvent({ path: `/api/campaigns/${CAMPAIGN}/sessions/s-1/commands`, method: 'POST' }) as never;

		for (let i = 0; i < limit; i++) await handle({ event: event(), resolve } as never);
		const denied = await handle({ event: event(), resolve } as never);

		expect(denied.status).toBe(429);
		const body = await denied.text();
		expect(body).not.toContain(CAMPAIGN);
		expect(body).not.toContain('user-alpha');
		expect(body).not.toContain('s-1');
		expect(denied.headers.get('Cache-Control')).toBe('private, no-store');
	});

	it('keeps unrelated campaigns out of each other’s bucket', async () => {
		const handle = makeHandle();
		const limit = CAMPAIGN_RATE_LIMIT_POLICIES['session-command'].limit;
		const post = (campaignId: string) =>
			fakeEvent({ path: `/api/campaigns/${campaignId}/sessions/s-1/commands`, method: 'POST' }) as never;

		for (let i = 0; i < limit; i++) await handle({ event: post(CAMPAIGN), resolve } as never);
		expect((await handle({ event: post(CAMPAIGN), resolve } as never)).status).toBe(429);
		expect((await handle({ event: post(OTHER_CAMPAIGN), resolve } as never)).status).toBe(200);
	});

	it('keeps unrelated users out of each other’s bucket', async () => {
		const limit = CAMPAIGN_RATE_LIMIT_POLICIES['session-command'].limit;
		const alpha = makeHandle({ userId: 'user-alpha' });
		const beta = makeHandle({ userId: 'user-beta' });
		const post = () =>
			fakeEvent({ path: `/api/campaigns/${CAMPAIGN}/sessions/s-1/commands`, method: 'POST' }) as never;

		for (let i = 0; i < limit; i++) await alpha({ event: post(), resolve } as never);
		expect((await alpha({ event: post(), resolve } as never)).status).toBe(429);
		expect((await beta({ event: post(), resolve } as never)).status).toBe(200);
	});

	it('buckets unauthenticated join attempts by client address', async () => {
		const handle = makeHandle({ userId: null });
		const limit = CAMPAIGN_RATE_LIMIT_POLICIES['join-attempt'].limit;
		const attempt = (address: string) =>
			fakeEvent({ path: '/api/campaigns/join/tok', method: 'POST', clientAddress: address }) as never;

		for (let i = 0; i < limit; i++) await handle({ event: attempt('203.0.113.7'), resolve } as never);
		const denied = await handle({ event: attempt('203.0.113.7'), resolve } as never);

		// Denied before the token is ever validated, so a rejected invite and a
		// nonexistent one are indistinguishable from outside.
		expect(denied.status).toBe(429);
		expect(await denied.text()).not.toContain('tok');
		expect((await handle({ event: attempt('198.51.100.9'), resolve } as never)).status).toBe(200);
	});
});

describe('missing production binding', () => {
	beforeEach(() => {
		resetRateLimitCountersForTest();
		resolve.mockClear();
	});

	const onEdgeWithoutBinding = (path: string, method: string) =>
		fakeEvent({ path, method, platformEnv: { CAMPAIGNS_ENABLED: 'true' } }) as never;

	it('fails closed for campaign mutations', async () => {
		const handle = makeHandle();
		const response = await handle({
			event: onEdgeWithoutBinding(`/api/campaigns/${CAMPAIGN}/sessions/s-1/commands`, 'POST'),
			resolve
		} as never);

		expect(response.status).toBe(503);
		expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
		expect(resolve).not.toHaveBeenCalled();
	});

	it('permits a degraded poll and counts it', async () => {
		const handle = makeHandle();
		const response = await handle({
			event: onEdgeWithoutBinding(`/api/campaigns/${CAMPAIGN}/sync`, 'GET'),
			resolve
		} as never);

		expect(response.status).toBe(200);
		expect(readDegradedPollCount()).toBe(1);
	});

	it('still uses the in-memory limiter off the edge, where it is development defence', async () => {
		const handle = makeHandle({ nodeEnv: 'development' });
		const event = () =>
			fakeEvent({ path: `/api/campaigns/${CAMPAIGN}/sessions/s-1/commands`, method: 'POST', platformEnv: null }) as never;

		expect((await handle({ event: event(), resolve } as never)).status).toBe(200);

		const limit = CAMPAIGN_RATE_LIMIT_POLICIES['session-command'].limit;
		for (let i = 1; i < limit; i++) await handle({ event: event(), resolve } as never);
		expect((await handle({ event: event(), resolve } as never)).status).toBe(429);
	});

	it('uses the binding when the platform provides one', async () => {
		const limit = vi.fn().mockResolvedValue({ success: false });
		const handle = makeHandle();
		const response = await handle({
			event: fakeEvent({
				path: `/api/campaigns/${CAMPAIGN}/sessions/s-1/commands`,
				method: 'POST',
				platformEnv: { CAMPAIGN_SESSION_COMMAND_LIMITER: { limit } }
			}) as never,
			resolve
		} as never);

		expect(limit).toHaveBeenCalledOnce();
		expect(response.status).toBe(429);
	});
});
