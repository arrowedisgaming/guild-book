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
 * VOLUME, BEFORE CAMPAIGNS GO PUBLIC: `poll_duration_ms` and `poll_no_change`
 * fire on every `/sync`, which is roughly one per second per open client. Nine
 * campaigns of three clients is ~27 lines/second. That is fine today, because
 * campaigns are server-gated off in production and the volume is zero, but it
 * is the number to look at before Task 6 Step 5 flips the flag — sample the two
 * poll metrics here rather than turning the whole sink off, since the command,
 * rejection, freeze and recovery points are low-volume and are the ones an
 * incident actually needs.
 */

let installed = false;

export function installCampaignMetricSink(): void {
	if (installed) return;
	installed = true;
	setCampaignMetricSink(emitStructuredLine);
}

/** Exposed for tests; returns the sink to its uninstalled state. */
export function resetCampaignMetricSinkForTest(): void {
	installed = false;
	setCampaignMetricSink(null);
}

function emitStructuredLine(point: CampaignMetricPoint): void {
	// A single line, parseable without a log-shipper. `metric` rather than
	// `name` so it does not collide with the platform's own log fields.
	console.log(
		JSON.stringify({
			metric: point.name,
			value: point.value,
			...point.tags
		})
	);
}
