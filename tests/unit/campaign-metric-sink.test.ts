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

		recordCampaignMetric({ name: 'poll_no_change', value: 1, tags: {} });

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

	it('drops a point whose name is not on the allowlist', () => {
		installCampaignMetricSink();

		recordCampaignMetric({ name: 'arbitrary_new_metric' as never, value: 1, tags: {} });

		expect(logged).toHaveLength(0);
	});
});
