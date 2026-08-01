import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordCampaignMetric } from '$lib/server/observability/campaign-metrics';
import {
	installCampaignMetricSink,
	resetCampaignMetricSinkForTest
} from '$lib/server/observability/metric-sink';

/**
 * The bug these cover shipped silently: the metrics layer was complete, tested,
 * and documented in the CHANGELOG as production observability — and no code
 * outside the test suite ever installed a sink, so every point was dropped in
 * every deployed environment. Unit tests passed throughout, because they
 * installed their own sink.
 *
 * So these assert the two things those tests could not: that installing the
 * real sink actually emits, and that what it emits is still free of
 * identifiers once it reaches a shared log pipeline.
 */
describe('the campaign metric sink', () => {
	let logged: string[];

	/** Queue the per-poll sampling rolls; polls beyond the queue are unsampled.
	 * A roll below 0.1 clears the 1-in-10 rate; 0.99 never does. */
	const stubRolls = (...values: number[]) => {
		const rolls = [...values];
		vi.spyOn(Math, 'random').mockImplementation(() => rolls.shift() ?? 0.99);
	};

	beforeEach(() => {
		logged = [];
		vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
			logged.push(String(line));
		});
		resetCampaignMetricSinkForTest();
	});

	afterEach(() => {
		resetCampaignMetricSinkForTest();
		vi.restoreAllMocks();
	});

	it('drops every point when no sink is installed — the shipped defect', () => {
		recordCampaignMetric({ name: 'command_duration_ms', value: 42, tags: {} });

		expect(logged).toHaveLength(0);
	});

	it('emits one structured line per point once installed', () => {
		installCampaignMetricSink();

		recordCampaignMetric({
			name: 'command_duration_ms',
			value: 42,
			tags: { commandType: 'end-round', actorRole: 'gm', outcome: 'accepted' }
		});

		expect(logged).toHaveLength(1);
		expect(JSON.parse(logged[0])).toEqual({
			metric: 'command_duration_ms',
			value: 42,
			commandType: 'end-round',
			actorRole: 'gm',
			outcome: 'accepted'
		});
	});

	it('installs only once, however many times it is called', () => {
		installCampaignMetricSink();
		installCampaignMetricSink();
		installCampaignMetricSink();

		recordCampaignMetric({ name: 'command_duration_ms', value: 1, tags: {} });

		// Three installs must not mean three log lines per point.
		expect(logged).toHaveLength(1);
	});

	it('cannot carry an identifier into the log even when a caller tries', () => {
		installCampaignMetricSink();

		recordCampaignMetric({
			name: 'command_duration_ms',
			value: 7,
			tags: {
				// Every one of these is a canary a careless caller might reach for.
				commandType: 'INVITE_TOKEN_CANARY',
				procedureKind: 'SECRET_PLAYER_hand',
				outcome: 'campaign-id-abc123xyz'
			} as never
		});

		const line = logged.join('\n');
		expect(line).not.toContain('INVITE_TOKEN_CANARY');
		expect(line).not.toContain('SECRET_PLAYER_');
		expect(line).not.toContain('abc123xyz');
	});

	it('emits only the polls whose roll clears the 1-in-10 rate, stamped with the rate', () => {
		installCampaignMetricSink();
		stubRolls(0.05, 0.5, 0.2, 0.09, 0.99);

		for (let i = 0; i < 5; i++) {
			recordCampaignMetric({ name: 'poll_duration_ms', value: i, tags: {} });
		}

		// Rolls 1 and 4 land under 0.1; the rest are dropped.
		expect(logged).toHaveLength(2);
		expect(JSON.parse(logged[0])).toEqual({ metric: 'poll_duration_ms', value: 0, sample: 10 });
		expect(JSON.parse(logged[1])).toEqual({ metric: 'poll_duration_ms', value: 3, sample: 10 });
	});

	it('rolls one shared decision per poll: an interleaved pair emits together or not at all', () => {
		installCampaignMetricSink();
		stubRolls(0);

		// The authoritative no-change shape: duration, then its no-change.
		for (let i = 0; i < 10; i++) {
			recordCampaignMetric({ name: 'poll_duration_ms', value: i, tags: { outcome: 'authoritative' } });
			recordCampaignMetric({ name: 'poll_no_change', value: 1, tags: { outcome: 'authoritative' } });
		}

		// Poll 1 is sampled and both its points ride that one decision, so the
		// emitted lines still show the true 100% no-change ratio — and ten
		// polls mean exactly ten rolls, never one per point.
		const metrics = logged.map((line) => JSON.parse(line).metric);
		expect(metrics).toEqual(['poll_duration_ms', 'poll_no_change']);
		expect(Math.random).toHaveBeenCalledTimes(10);
	});

	it('does not inflate a rare no-change into a sampled line of its own', () => {
		installCampaignMetricSink();
		const rolls = Array.from({ length: 20 }, (_, i) => (i === 0 || i === 10 ? 0 : 0.99));
		stubRolls(...rolls);

		// 20 polls, exactly one of which (poll 6) is a no-change: a 5% ratio.
		for (let i = 0; i < 20; i++) {
			recordCampaignMetric({ name: 'poll_duration_ms', value: i, tags: {} });
			if (i === 5) {
				recordCampaignMetric({ name: 'poll_no_change', value: 1, tags: { outcome: 'authoritative' } });
			}
		}

		// Per-metric sampling would emit poll 6's no-change as its own "first
		// point", which a reader multiplies into 10 no-changes out of 20 polls.
		// The shared per-poll decision drops it along with its unsampled poll.
		expect(logged.map((line) => JSON.parse(line).value)).toEqual([0, 10]);
	});

	it('gives a hint-answered poll one decision across its no-change and trailing duration', () => {
		installCampaignMetricSink();
		stubRolls(0, 0.99, 0);

		// The hint shape as production emits it: `hasFreshMatchingCursorHint`
		// records the no-change, then the /sync route records the duration.
		for (let i = 0; i < 3; i++) {
			recordCampaignMetric({ name: 'poll_no_change', value: 1, tags: { outcome: 'hint' } });
			recordCampaignMetric({ name: 'poll_duration_ms', value: i, tags: {} });
		}

		// Polls 1 and 3 emit both halves; poll 2 emits neither. Treating the
		// trailing duration as a poll of its own would split the pair — the
		// sampled no-change without its duration is exactly the ratio
		// inflation this sampling scheme exists to prevent.
		const metrics = logged.map((line) => JSON.parse(line).metric);
		expect(metrics).toEqual([
			'poll_no_change',
			'poll_duration_ms',
			'poll_no_change',
			'poll_duration_ms'
		]);
		expect(logged.map((line) => JSON.parse(line).value)).toEqual([1, 0, 1, 2]);
		expect(Math.random).toHaveBeenCalledTimes(3);
	});

	it('never samples command, rejection, freeze, or recovery points', () => {
		installCampaignMetricSink();

		for (let i = 0; i < 20; i++) {
			recordCampaignMetric({ name: 'command_duration_ms', value: i, tags: {} });
			recordCampaignMetric({ name: 'command_retry_count', value: 0, tags: {} });
		}
		recordCampaignMetric({ name: 'command_rejection', value: 1, tags: {} });
		recordCampaignMetric({ name: 'session_frozen', value: 1, tags: {} });
		recordCampaignMetric({ name: 'session_recovered', value: 1, tags: {} });

		expect(logged).toHaveLength(43);
		for (const line of logged) {
			expect(JSON.parse(line)).not.toHaveProperty('sample');
		}
	});

	it('drops a point whose name is not on the allowlist', () => {
		installCampaignMetricSink();

		recordCampaignMetric({ name: 'arbitrary_new_metric' as never, value: 1, tags: {} });

		expect(logged).toHaveLength(0);
	});
});
