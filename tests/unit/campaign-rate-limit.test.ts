import { describe, expect, it, vi } from 'vitest';
import {
	CAMPAIGN_RATE_LIMIT_POLICIES,
	buildRateLimitKey,
	enforceCampaignRateLimit,
	readDegradedPollCount,
	resetRateLimitCountersForTest
} from '$lib/server/rate-limit/campaign';
import {
	createCloudflareRateLimiter,
	probeRateLimitEnforcement
} from '$lib/server/rate-limit/cloudflare';
import { createMemoryRateLimiter } from '$lib/server/rate-limit/memory';
import { RateLimitUnavailableError, type RateLimitPolicy } from '$lib/server/rate-limit/types';

/**
 * Increment 5 Task 1 Step 1 — policy tests for the provider-neutral shared
 * rate-limit port. These cover bucket independence, the hashing that keeps raw
 * identifiers out of provider analytics, the `Retry-After` contract, and the
 * asymmetric availability behaviour (mutations fail closed, polls degrade
 * open) required by Step 4.
 */

const ALL_POLICIES: RateLimitPolicy[] = [
	'session-command',
	'campaign-mutation',
	'join-attempt',
	'session-poll'
];

describe('campaign rate-limit policies', () => {
	it('defines every policy the plan names', () => {
		expect(Object.keys(CAMPAIGN_RATE_LIMIT_POLICIES).sort()).toEqual([...ALL_POLICIES].sort());
	});

	it('only uses periods the Cloudflare binding can honour (amendment 3)', () => {
		// `[ratelimits.simple]` accepts exactly 10 or 60 seconds. Exposing any
		// other window would be an API this provider cannot implement.
		for (const policy of ALL_POLICIES) {
			expect([10, 60]).toContain(CAMPAIGN_RATE_LIMIT_POLICIES[policy].periodSeconds);
		}
	});

	it('classifies mutations and reads so availability failures can diverge', () => {
		expect(CAMPAIGN_RATE_LIMIT_POLICIES['session-command'].kind).toBe('mutation');
		expect(CAMPAIGN_RATE_LIMIT_POLICIES['campaign-mutation'].kind).toBe('mutation');
		expect(CAMPAIGN_RATE_LIMIT_POLICIES['join-attempt'].kind).toBe('mutation');
		expect(CAMPAIGN_RATE_LIMIT_POLICIES['session-poll'].kind).toBe('read');
	});

	it('gives the polling policy enough budget for the ~1s cadence', () => {
		const poll = CAMPAIGN_RATE_LIMIT_POLICIES['session-poll'];
		expect(poll.limit / poll.periodSeconds).toBeGreaterThanOrEqual(2);
	});
});

describe('bucket key derivation', () => {
	const base = { actorUserId: 'user-alpha', campaignId: 'camp-one', clientAddress: '203.0.113.7' };

	it('is stable for the same actor, campaign and policy', () => {
		const first = buildRateLimitKey({ policy: 'session-command', ...base });
		const second = buildRateLimitKey({ policy: 'session-command', ...base });
		expect(first).toBe(second);
	});

	it('does not share a bucket across policies', () => {
		const keys = ALL_POLICIES.map((policy) => buildRateLimitKey({ policy, ...base }));
		expect(new Set(keys).size).toBe(ALL_POLICIES.length);
	});

	it('does not share a bucket across campaigns', () => {
		const one = buildRateLimitKey({ policy: 'session-command', ...base });
		const two = buildRateLimitKey({ policy: 'session-command', ...base, campaignId: 'camp-two' });
		expect(one).not.toBe(two);
	});

	it('does not share a bucket across users in the same campaign', () => {
		const one = buildRateLimitKey({ policy: 'session-command', ...base });
		const two = buildRateLimitKey({ policy: 'session-command', ...base, actorUserId: 'user-beta' });
		expect(one).not.toBe(two);
	});

	it('keys authenticated actors independently of the address they arrive from', () => {
		const one = buildRateLimitKey({ policy: 'session-command', ...base });
		const two = buildRateLimitKey({ policy: 'session-command', ...base, clientAddress: '198.51.100.9' });
		expect(one).toBe(two);
	});

	it('falls back to the client address when the actor is unauthenticated', () => {
		const anonymous = buildRateLimitKey({
			policy: 'join-attempt',
			clientAddress: '203.0.113.7'
		});
		const otherAddress = buildRateLimitKey({
			policy: 'join-attempt',
			clientAddress: '198.51.100.9'
		});
		expect(anonymous).not.toBe(otherAddress);
	});

	it('never puts a raw identifier or address into the provider key', () => {
		for (const policy of ALL_POLICIES) {
			const key = buildRateLimitKey({ policy, ...base });
			expect(key).not.toContain(base.actorUserId);
			expect(key).not.toContain(base.campaignId);
			expect(key).not.toContain(base.clientAddress);
		}
		const anonymous = buildRateLimitKey({ policy: 'join-attempt', clientAddress: base.clientAddress });
		expect(anonymous).not.toContain(base.clientAddress);
	});

	it('keeps the policy readable so operators can attribute a bucket', () => {
		expect(buildRateLimitKey({ policy: 'session-poll', ...base }).startsWith('session-poll:')).toBe(true);
	});
});

describe('memory limiter', () => {
	it('allows exactly the policy limit inside one window', async () => {
		let now = 1_000_000;
		const limiter = createMemoryRateLimiter({ now: () => now });
		const key = 'session-poll:abc';
		const limit = CAMPAIGN_RATE_LIMIT_POLICIES['session-poll'].limit;

		for (let i = 0; i < limit; i++) {
			const decision = await limiter.check({ key, policy: 'session-poll' });
			expect(decision.allowed).toBe(true);
		}

		const denied = await limiter.check({ key, policy: 'session-poll' });
		expect(denied.allowed).toBe(false);
		expect(denied.retryAfterSeconds).toBeGreaterThan(0);
		expect(denied.retryAfterSeconds).toBeLessThanOrEqual(
			CAMPAIGN_RATE_LIMIT_POLICIES['session-poll'].periodSeconds
		);
	});

	it('refills after the window elapses on the injected clock', async () => {
		let now = 1_000_000;
		const limiter = createMemoryRateLimiter({ now: () => now });
		const key = 'join-attempt:abc';
		const { limit, periodSeconds } = CAMPAIGN_RATE_LIMIT_POLICIES['join-attempt'];

		for (let i = 0; i < limit; i++) await limiter.check({ key, policy: 'join-attempt' });
		expect((await limiter.check({ key, policy: 'join-attempt' })).allowed).toBe(false);

		now += periodSeconds * 1000;
		expect((await limiter.check({ key, policy: 'join-attempt' })).allowed).toBe(true);
	});

	it('keeps distinct keys in distinct buckets', async () => {
		const limiter = createMemoryRateLimiter({ now: () => 5 });
		const limit = CAMPAIGN_RATE_LIMIT_POLICIES['join-attempt'].limit;
		for (let i = 0; i < limit; i++) await limiter.check({ key: 'a', policy: 'join-attempt' });

		expect((await limiter.check({ key: 'a', policy: 'join-attempt' })).allowed).toBe(false);
		expect((await limiter.check({ key: 'b', policy: 'join-attempt' })).allowed).toBe(true);
	});
});

describe('cloudflare adapter', () => {
	it('maps a successful binding call to an allowed decision', async () => {
		const limit = vi.fn().mockResolvedValue({ success: true });
		const limiter = createCloudflareRateLimiter({ 'session-command': { limit } });

		const decision = await limiter.check({ key: 'session-command:abc', policy: 'session-command' });

		expect(decision.allowed).toBe(true);
		expect(limit).toHaveBeenCalledWith({ key: 'session-command:abc' });
	});

	it('maps a rejected binding call to a denial carrying the policy period', async () => {
		const limiter = createCloudflareRateLimiter({
			'session-poll': { limit: vi.fn().mockResolvedValue({ success: false }) }
		});

		const decision = await limiter.check({ key: 'session-poll:abc', policy: 'session-poll' });

		expect(decision.allowed).toBe(false);
		expect(decision.retryAfterSeconds).toBe(CAMPAIGN_RATE_LIMIT_POLICIES['session-poll'].periodSeconds);
	});

	it('reports an absent binding as unavailable rather than allowing silently', async () => {
		const limiter = createCloudflareRateLimiter({});
		await expect(
			limiter.check({ key: 'session-command:abc', policy: 'session-command' })
		).rejects.toBeInstanceOf(RateLimitUnavailableError);
	});

	it('reports a throwing binding as unavailable', async () => {
		const limiter = createCloudflareRateLimiter({
			'session-command': { limit: vi.fn().mockRejectedValue(new Error('edge down')) }
		});
		await expect(
			limiter.check({ key: 'session-command:abc', policy: 'session-command' })
		).rejects.toBeInstanceOf(RateLimitUnavailableError);
	});
});

describe('enforcement self-test', () => {
	it('reports enforcing when the binding eventually denies', async () => {
		let calls = 0;
		const binding = { limit: vi.fn(async () => ({ success: ++calls <= 1 })) };

		await expect(probeRateLimitEnforcement(binding, 1)).resolves.toBe('enforcing');
	});

	it('reports not-enforcing when the binding always allows', async () => {
		// The staging failure, reproduced: a binding that is present, returns a
		// well-formed outcome, and never counts. Indistinguishable from "under
		// the limit" to every other code path — which is why this probe exists.
		const binding = { limit: vi.fn(async () => ({ success: true })) };

		await expect(probeRateLimitEnforcement(binding, 1)).resolves.toBe('not-enforcing');
		expect(binding.limit).toHaveBeenCalledTimes(2);
	});

	it('reports absent when the binding is not configured', async () => {
		await expect(probeRateLimitEnforcement(undefined, 1)).resolves.toBe('absent');
	});

	it('reports unavailable when the binding throws', async () => {
		const binding = { limit: vi.fn().mockRejectedValue(new Error('edge down')) };
		await expect(probeRateLimitEnforcement(binding, 1)).resolves.toBe('unavailable');
	});

	it('stops as soon as it has proof, rather than spending the whole budget', async () => {
		const binding = { limit: vi.fn(async () => ({ success: false })) };

		await expect(probeRateLimitEnforcement(binding, 30)).resolves.toBe('enforcing');
		expect(binding.limit).toHaveBeenCalledOnce();
	});

	it('always uses one fixed, non-identifying key', async () => {
		const binding = { limit: vi.fn(async (_input: { key: string }) => ({ success: true })) };
		await probeRateLimitEnforcement(binding, 2);

		const keys = binding.limit.mock.calls.map(([input]) => input.key);
		expect(new Set(keys).size).toBe(1);
		expect(keys[0]).toBe('health-self-test');
	});
});

describe('availability behaviour', () => {
	const scope = { actorUserId: 'user-alpha', campaignId: 'camp-one', clientAddress: '203.0.113.7' };

	function unavailableLimiter() {
		return {
			check: vi.fn().mockRejectedValue(new RateLimitUnavailableError('binding missing'))
		};
	}

	it('fails closed for every mutation policy when the provider is unavailable', async () => {
		resetRateLimitCountersForTest();
		for (const policy of ALL_POLICIES.filter((p) => CAMPAIGN_RATE_LIMIT_POLICIES[p].kind === 'mutation')) {
			const outcome = await enforceCampaignRateLimit(unavailableLimiter(), { policy, ...scope });
			expect(outcome.allowed).toBe(false);
			expect(outcome.reason).toBe('provider-unavailable');
			expect(outcome.retryAfterSeconds).toBeGreaterThan(0);
		}
		expect(readDegradedPollCount()).toBe(0);
	});

	it('degrades open for polls and counts the degradation', async () => {
		resetRateLimitCountersForTest();
		const outcome = await enforceCampaignRateLimit(unavailableLimiter(), {
			policy: 'session-poll',
			...scope
		});

		expect(outcome.allowed).toBe(true);
		expect(outcome.reason).toBe('provider-unavailable');
		expect(readDegradedPollCount()).toBe(1);
	});

	it('reports a plain limit denial distinctly from an outage', async () => {
		resetRateLimitCountersForTest();
		const limiter = { check: vi.fn().mockResolvedValue({ allowed: false, retryAfterSeconds: 60 }) };

		const outcome = await enforceCampaignRateLimit(limiter, { policy: 'campaign-mutation', ...scope });

		expect(outcome.allowed).toBe(false);
		expect(outcome.reason).toBe('limited');
		expect(outcome.retryAfterSeconds).toBe(60);
	});

	it('hands the provider only the hashed key', async () => {
		resetRateLimitCountersForTest();
		const check = vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });

		await enforceCampaignRateLimit({ check }, { policy: 'session-command', ...scope });

		const [input] = check.mock.calls[0];
		expect(input.key).toBe(buildRateLimitKey({ policy: 'session-command', ...scope }));
		expect(JSON.stringify(input)).not.toContain(scope.actorUserId);
		expect(JSON.stringify(input)).not.toContain(scope.campaignId);
		expect(JSON.stringify(input)).not.toContain(scope.clientAddress);
	});
});
