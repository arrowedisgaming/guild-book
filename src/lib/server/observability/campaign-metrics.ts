/**
 * Privacy-safe campaign operations signals (Increment 5 Task 2).
 *
 * The point of this module is what it CANNOT express. There is deliberately
 * no `Record<string, unknown>` sink and no free-text field: the metric name is
 * a closed union, the tag keys are fixed, and every tag value is sanitized
 * against a known enum before it leaves. A caller that passes a whole command,
 * envelope or session object gets counts and coarse labels recorded and
 * everything else dropped — it cannot leak an invite token, a card identity, a
 * character payload, or an id, because there is no field for one.
 *
 * Increment 5's Global Constraints forbid logging command bodies, private
 * projections, hidden-zone card ids, invite tokens, HMAC claims, raw character
 * JSON and session server/private state. This shape is how that is enforced
 * rather than remembered.
 */

export const CAMPAIGN_METRIC_NAMES = [
	'command_duration_ms',
	'command_retry_count',
	'command_rejection',
	'poll_duration_ms',
	'poll_no_change',
	'session_frozen',
	'session_recovered'
] as const;

export type CampaignMetricName = (typeof CAMPAIGN_METRIC_NAMES)[number];

export interface CampaignMetricTags {
	commandType?: string;
	procedureKind?: string;
	actorRole?: 'gm' | 'player';
	outcome?: string;
}

export interface CampaignMetricPoint {
	name: CampaignMetricName;
	value: number;
	tags: CampaignMetricTags;
}

export type CampaignMetricSink = (point: CampaignMetricPoint) => void;

/** Mirrors the fifteen `z.literal` discriminants in `session.schema.ts`. */
const KNOWN_COMMAND_TYPES = new Set([
	'draw',
	'deal',
	'play',
	'place-facedown',
	'reveal',
	'discard',
	'transfer',
	'select-from-discard',
	'reorder-top',
	'mulligan',
	'begin-procedure',
	'advance-procedure',
	'complete-procedure',
	'end-round',
	'apply-correction'
]);

/**
 * `SessionPhase`, not procedure id. "the table is in camp" is an operational
 * fact; "the table is running camp-high-chant right now" is play content.
 */
const KNOWN_PROCEDURE_KINDS = new Set(['crawl', 'challenge', 'camp', 'city']);

/** `CommandRejectionCode` plus the non-rejection outcomes worth counting. */
const KNOWN_OUTCOMES = new Set([
	'accepted',
	'duplicate',
	'not-authorized',
	'illegal-command',
	'stale-structure',
	'command-id-reused',
	'content-mismatch',
	'retry-exhausted',
	// Freeze reasons, from `freezeSessionForFailure` and the GM-initiated path.
	'load-integrity-failure',
	'invariant-violation',
	'gm-requested',
	// Poll outcomes: `hint` was answered from the isolate-local cursor hint
	// with no D1 read; `authoritative` did read D1 and found nothing changed.
	// The ratio is what says whether the hint is earning its keep.
	'hint',
	'authoritative'
]);

const COARSE_FALLBACK = 'other';
const METRIC_NAMES = new Set<string>(CAMPAIGN_METRIC_NAMES);

let sink: CampaignMetricSink | null = null;

/** Install the process sink. `null` disables recording entirely. */
export function setCampaignMetricSink(next: CampaignMetricSink | null): void {
	sink = next;
}

/**
 * Sanitize and emit one point. Silently drops anything off the allowlist —
 * observability must never be able to fail a command, and a metric that
 * cannot be expressed safely is simply not recorded.
 */
export function recordCampaignMetric(point: CampaignMetricPoint): void {
	if (!sink) return;
	if (!METRIC_NAMES.has(point?.name)) return;

	const safe: CampaignMetricPoint = {
		name: point.name,
		value: safeValue(point.value),
		tags: safeTags(point.tags)
	};

	try {
		sink(safe);
	} catch {
		// A broken sink is an operations problem, not a gameplay one. Swallow
		// it — and do not log the point, which is the one thing here that could
		// carry a caller's mistake into the log.
	}
}

export interface CommandOutcomeSample {
	durationMs: number;
	/** Total attempts made, 1-based. Retries recorded are `attempts - 1`. */
	attempts: number;
	commandType?: string;
	procedureKind?: string;
	actorRole?: 'gm' | 'player';
	/** `accepted`, `duplicate`, or a `CommandRejectionCode`. */
	outcome: string;
}

export function recordCommandOutcome(sample: CommandOutcomeSample): void {
	if (!sink) return;

	const tags: CampaignMetricTags = {
		commandType: sample.commandType,
		procedureKind: sample.procedureKind,
		actorRole: sample.actorRole,
		outcome: sample.outcome
	};

	recordCampaignMetric({ name: 'command_duration_ms', value: Math.round(sample.durationMs), tags });
	recordCampaignMetric({
		name: 'command_retry_count',
		value: Math.max(0, Math.round(sample.attempts) - 1),
		tags
	});

	const rejected = sample.outcome !== 'accepted' && sample.outcome !== 'duplicate';
	if (rejected) recordCampaignMetric({ name: 'command_rejection', value: 1, tags });
}

export function recordPoll(sample: {
	durationMs: number;
	changed: boolean;
	/** `hint` or `authoritative` — how the no-change answer was reached. */
	outcome?: string;
}): void {
	if (!sink) return;
	const tags: CampaignMetricTags = { outcome: sample.outcome };
	recordCampaignMetric({ name: 'poll_duration_ms', value: Math.round(sample.durationMs), tags });
	if (!sample.changed) recordCampaignMetric({ name: 'poll_no_change', value: 1, tags });
}

export function recordSessionFrozen(sample: { reason: string }): void {
	recordCampaignMetric({ name: 'session_frozen', value: 1, tags: { outcome: sample?.reason } });
}

export function recordSessionRecovered(): void {
	recordCampaignMetric({ name: 'session_recovered', value: 1, tags: {} });
}

function safeValue(value: unknown): number {
	const numeric = typeof value === 'number' ? value : Number.NaN;
	if (!Number.isFinite(numeric) || numeric < 0) return 0;
	return numeric;
}

/**
 * Rebuilt key by key rather than filtered, so an unexpected property cannot
 * survive by being present on the input object.
 */
function safeTags(tags: CampaignMetricTags | undefined): CampaignMetricTags {
	const safe: CampaignMetricTags = {};
	if (!tags || typeof tags !== 'object') return safe;

	const commandType = coarse(tags.commandType, KNOWN_COMMAND_TYPES);
	if (commandType !== undefined) safe.commandType = commandType;

	const procedureKind = coarse(tags.procedureKind, KNOWN_PROCEDURE_KINDS);
	if (procedureKind !== undefined) safe.procedureKind = procedureKind;

	// No fallback label: an unrecognised role is dropped, because `other` would
	// be a third role that does not exist.
	if (tags.actorRole === 'gm' || tags.actorRole === 'player') safe.actorRole = tags.actorRole;

	const outcome = coarse(tags.outcome, KNOWN_OUTCOMES);
	if (outcome !== undefined) safe.outcome = outcome;

	return safe;
}

function coarse(value: unknown, known: Set<string>): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'string') return COARSE_FALLBACK;
	return known.has(value) ? value : COARSE_FALLBACK;
}
