import { setCampaignMetricSink, type CampaignMetricPoint } from './campaign-metrics';

/**
 * Install the process metric sink.
 *
 * WHY THIS EXISTS: without it, the whole campaign metrics layer is inert.
 * `recordCampaignMetric` returns immediately when no sink is installed, and
 * before this module the only callers of `setCampaignMetricSink` were tests —
 * so every command duration, retry count, rejection, poll, freeze and recovery
 * was computed and then dropped in every deployed environment. The 0.7.0
 * pre-release review caught it; the CHANGELOG had been advertising working
 * production observability for a feature that emitted nothing.
 *
 * WHY `console.log`: Workers has no metrics binding configured here, and its
 * platform log pipeline (`wrangler tail`, Workers Logs) already collects
 * stdout. One structured JSON line per point is the least machinery that makes
 * the layer real, and it needs no new binding, secret or vendor.
 *
 * WHY THIS IS SAFE TO LOG: `recordCampaignMetric` sanitises before it calls the
 * sink — the metric name is checked against a closed allowlist, the value is
 * coerced to a finite number, and tags are restricted to a fixed shape whose
 * values are matched against known enums. There is no free-text field and no
 * `Record<string, unknown>`, so a caller cannot route an id, a card identity,
 * an invite token or a command body through here even by mistake. That is the
 * property that makes emitting these to a shared log pipeline defensible,
 * unlike the surrounding session logs (see `campaign-rollback.md` §5).
 *
 * VOLUME: `poll_duration_ms` fires on every `/sync` (roughly one per second
 * per open client) and `poll_no_change` adds a second line on the no-change
 * majority of them — ~50 lines/second at pilot scale and growing linearly
 * with public users. So those two, and only those two, are
 * sampled 1-in-10 below rather than the whole sink being turned off: the
 * command, rejection, freeze and recovery points are low-volume and are the
 * ones an incident actually needs, and they stay unsampled. The sampling
 * decision is PROBABILISTIC and made once per POLL, not per metric or on a
 * counter: `poll_no_change` only fires on some polls, so sampling it
 * independently turns a rare no-change into a guaranteed "first point" line
 * and wildly overstates the no-change ratio at low volume — and a
 * deterministic every-Nth counter would alias periodic outcome patterns and
 * over-sample fresh isolates (every restart re-samples its "first" poll). A
 * random 1-in-10 roll shared by both of a poll's points has none of those
 * biases. Every emitted sampled line carries `sample: 10` so a reader
 * multiplies counts back up instead of misreading a tenth of the traffic as
 * all of it.
 */

const POLL_SAMPLE_RATE = 10;
let currentPollSampled = false;
let hintDurationPending = false;

let installed = false;

export function installCampaignMetricSink(): void {
	if (installed) return;
	installed = true;
	setCampaignMetricSink(emitStructuredLine);
}

/** Exposed for tests; returns the sink to its uninstalled state. */
export function resetCampaignMetricSinkForTest(): void {
	installed = false;
	currentPollSampled = false;
	hintDurationPending = false;
	setCampaignMetricSink(null);
}

function emitStructuredLine(point: CampaignMetricPoint): void {
	const sampled = point.name === 'poll_duration_ms' || point.name === 'poll_no_change';
	if (sampled) {
		// A poll reaches this sink in one of three shapes, each emitted
		// synchronously (no awaits between the points) inside one handler:
		//   hint:          poll_no_change(outcome 'hint'), then poll_duration_ms
		//                  (`hasFreshMatchingCursorHint`, then the /sync route)
		//   authoritative: poll_duration_ms, then poll_no_change (`recordPoll`)
		//   changed:       poll_duration_ms alone (`recordPoll`)
		// So a hint no-change starts a poll and flags that its duration is the
		// same poll's trailer; a duration starts a poll unless it is that
		// trailer; any other no-change inherits its poll's decision.
		const hintNoChange = point.name === 'poll_no_change' && point.tags.outcome === 'hint';
		const startsPoll = hintNoChange || (point.name === 'poll_duration_ms' && !hintDurationPending);
		if (startsPoll) currentPollSampled = Math.random() * POLL_SAMPLE_RATE < 1;
		hintDurationPending = hintNoChange;
		if (!currentPollSampled) return;
	}
	// A single line, parseable without a log-shipper. `metric` rather than
	// `name` so it does not collide with the platform's own log fields.
	console.log(
		JSON.stringify({
			metric: point.name,
			value: point.value,
			...point.tags,
			...(sampled ? { sample: POLL_SAMPLE_RATE } : {})
		})
	);
}
