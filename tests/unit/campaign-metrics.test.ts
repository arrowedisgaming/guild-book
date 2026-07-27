import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	CAMPAIGN_METRIC_NAMES,
	recordCampaignMetric,
	recordCommandOutcome,
	recordPoll,
	recordSessionFrozen,
	recordSessionRecovered,
	setCampaignMetricSink,
	type CampaignMetricPoint
} from '$lib/server/observability/campaign-metrics';

/**
 * Increment 5 Task 2 Step 1 — redaction tests. Every helper is fed objects
 * carrying invite, card and character canaries; nothing but names, counts,
 * durations, status/rejection codes, retries and coarse role/procedure labels
 * may reach the sink.
 */

const INVITE_CANARY = 'INVITE_TOKEN_CANARY';
const CARD_CANARY = 'SECRET_PLAYER_CARD_ace-of-swords';
const CHARACTER_CANARY = 'CHARACTER_JSON_CANARY';
const ALL_CANARIES = [INVITE_CANARY, CARD_CANARY, CHARACTER_CANARY, 'user-alpha', 'camp-one'];

let points: CampaignMetricPoint[];

function serialized(): string {
	return JSON.stringify(points);
}

function expectNoCanaries(): void {
	for (const canary of ALL_CANARIES) {
		expect(serialized()).not.toContain(canary);
	}
}

beforeEach(() => {
	points = [];
	setCampaignMetricSink((point) => points.push(point));
});

afterEach(() => setCampaignMetricSink(null));

describe('metric allowlist', () => {
	it('exposes exactly the seven names the plan fixes', () => {
		expect([...CAMPAIGN_METRIC_NAMES].sort()).toEqual(
			[
				'command_duration_ms',
				'command_retry_count',
				'command_rejection',
				'poll_duration_ms',
				'poll_no_change',
				'session_frozen',
				'session_recovered'
			].sort()
		);
	});

	it('drops a point whose name is not on the allowlist', () => {
		recordCampaignMetric({ name: 'command_body' as never, value: 1, tags: {} });
		expect(points).toHaveLength(0);
	});

	it('strips tag keys outside the fixed shape', () => {
		recordCampaignMetric({
			name: 'command_duration_ms',
			value: 12,
			tags: {
				commandType: 'draw',
				inviteToken: INVITE_CANARY,
				cardId: CARD_CANARY,
				characterJson: CHARACTER_CANARY
			} as never
		});

		expect(points).toHaveLength(1);
		expect(Object.keys(points[0].tags)).toEqual(['commandType']);
		expectNoCanaries();
	});

	it('coerces a non-finite or negative value to a safe number', () => {
		recordCampaignMetric({ name: 'command_duration_ms', value: Number.NaN, tags: {} });
		recordCampaignMetric({ name: 'command_retry_count', value: -4, tags: {} });
		recordCampaignMetric({ name: 'poll_duration_ms', value: Number.POSITIVE_INFINITY, tags: {} });

		expect(points.map((p) => p.value)).toEqual([0, 0, 0]);
	});
});

describe('tag sanitization', () => {
	it('replaces an unknown command type with a coarse label', () => {
		recordCampaignMetric({ name: 'command_rejection', value: 1, tags: { commandType: CARD_CANARY } });
		expect(points[0].tags.commandType).toBe('other');
		expectNoCanaries();
	});

	it('keeps a real command type verbatim', () => {
		recordCampaignMetric({ name: 'command_rejection', value: 1, tags: { commandType: 'advance-procedure' } });
		expect(points[0].tags.commandType).toBe('advance-procedure');
	});

	it('reduces a procedure to its coarse phase', () => {
		recordCampaignMetric({ name: 'command_duration_ms', value: 1, tags: { procedureKind: 'camp' } });
		expect(points[0].tags.procedureKind).toBe('camp');

		recordCampaignMetric({
			name: 'command_duration_ms',
			value: 1,
			tags: { procedureKind: 'camp-high-chant' }
		});
		// A specific procedure id is not a coarse label — it says what the table
		// is doing right now.
		expect(points[1].tags.procedureKind).toBe('other');
	});

	it('drops an actor role that is not gm or player', () => {
		recordCampaignMetric({ name: 'command_duration_ms', value: 1, tags: { actorRole: 'user-alpha' as never } });
		expect(points[0].tags.actorRole).toBeUndefined();
		expectNoCanaries();
	});

	it('replaces an unknown outcome with a coarse label', () => {
		recordCampaignMetric({ name: 'command_rejection', value: 1, tags: { outcome: 'stale-structure' } });
		expect(points[0].tags.outcome).toBe('stale-structure');

		recordCampaignMetric({ name: 'command_rejection', value: 1, tags: { outcome: INVITE_CANARY } });
		expect(points[1].tags.outcome).toBe('other');
		expectNoCanaries();
	});
});

describe('helpers', () => {
	it('records duration, retries and rejection for one command without identifiers', () => {
		recordCommandOutcome({
			durationMs: 42.7,
			attempts: 3,
			commandType: 'draw',
			actorRole: 'player',
			outcome: 'stale-structure',
			// Callers pass whole objects; these must not survive.
			campaignId: 'camp-one',
			actorUserId: 'user-alpha',
			inviteToken: INVITE_CANARY,
			drawnCardId: CARD_CANARY
		} as never);

		const names = points.map((p) => p.name);
		expect(names).toContain('command_duration_ms');
		expect(names).toContain('command_retry_count');
		expect(names).toContain('command_rejection');

		const duration = points.find((p) => p.name === 'command_duration_ms');
		expect(duration?.value).toBe(43);
		expect(duration?.tags).toEqual({ commandType: 'draw', actorRole: 'player', outcome: 'stale-structure' });

		expect(points.find((p) => p.name === 'command_retry_count')?.value).toBe(2);
		expectNoCanaries();
	});

	it('does not emit a rejection point for an accepted command', () => {
		recordCommandOutcome({
			durationMs: 5,
			attempts: 1,
			commandType: 'play',
			actorRole: 'gm',
			outcome: 'accepted'
		});

		expect(points.map((p) => p.name)).not.toContain('command_rejection');
		expect(points.find((p) => p.name === 'command_retry_count')?.value).toBe(0);
	});

	it('separates changed polls from no-change polls', () => {
		recordPoll({ durationMs: 8, changed: false });
		recordPoll({ durationMs: 9, changed: true });

		expect(points.filter((p) => p.name === 'poll_no_change')).toHaveLength(1);
		expect(points.filter((p) => p.name === 'poll_duration_ms')).toHaveLength(2);
	});

	it('records freeze and recovery with a coarse reason only', () => {
		recordSessionFrozen({ reason: 'load-integrity-failure', sessionId: 'sess-1', campaignId: 'camp-one' } as never);
		// Takes no argument at all — there is nothing to record but the fact, so
		// a caller cannot pass a session or campaign even by mistake.
		recordSessionRecovered();

		expect(points[0]).toEqual({
			name: 'session_frozen',
			value: 1,
			tags: { outcome: 'load-integrity-failure' }
		});
		expect(points[1]).toEqual({ name: 'session_recovered', value: 1, tags: {} });
		expectNoCanaries();
	});
});

describe('sink safety', () => {
	it('never lets a failing sink break the caller', () => {
		setCampaignMetricSink(() => {
			throw new Error('sink exploded');
		});

		expect(() => recordCommandOutcome({ durationMs: 1, attempts: 1, commandType: 'draw', actorRole: 'gm', outcome: 'accepted' })).not.toThrow();
	});

	it('is a no-op with no sink installed', () => {
		setCampaignMetricSink(null);
		expect(() => recordPoll({ durationMs: 1, changed: false })).not.toThrow();
	});

	it('does not accept a generic record-anything interface', () => {
		// Guard against the interface drifting back to Record<string, unknown>:
		// the sink must only ever see the three fixed fields.
		recordCampaignMetric({ name: 'poll_no_change', value: 1, tags: {} });
		expect(Object.keys(points[0]).sort()).toEqual(['name', 'tags', 'value']);
	});

	it('reports metrics through a mocked sink exactly once per record', () => {
		const sink = vi.fn();
		setCampaignMetricSink(sink);
		recordCampaignMetric({ name: 'session_recovered', value: 1, tags: {} });
		expect(sink).toHaveBeenCalledOnce();
	});
});
