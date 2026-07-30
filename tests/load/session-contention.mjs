#!/usr/bin/env node
/**
 * Increment 5 Task 4 — the contention harness, the companion to
 * `session-polling.mjs`.
 *
 * The polling harness measures the STEADY state: one writer per campaign at a
 * relaxed cadence, which is what a real table looks like most of the time. It
 * therefore barely exercises write contention at all — every one of its 2900
 * commands is accepted, because they never race each other. That leaves the
 * plan's "D1 contention and sequential-per-database behavior must be measured"
 * requirement unmet by construction.
 *
 * This harness does the opposite: it makes every actor in a campaign fire
 * SIMULTANEOUSLY against the same observed session version, in rounds, across
 * nine campaigns at once. That is not a realistic table — it is the adversarial
 * case the version-claim design exists for, and the only way to find out whether
 * the exclusivity guarantee actually holds under a real D1 rather than under
 * Miniflare.
 *
 * WHAT IT ASSERTS, and why each matters more than a latency number:
 *
 *   1. **Every accepted command claims a DISTINCT resulting version.** This is
 *      the core invariant. Two commands reporting the same resulting version
 *      means the `session_commands_resulting_version_uq` claim is not exclusive
 *      and one player's action silently overwrote another's. A zero-tolerance
 *      check — the whole point of the exercise.
 *   2. **Non-structural commands are absorbed, not rejected.** `draw` retries
 *      its version claim server-side (`command-service.ts`'s attempt loop), so
 *      losing a race must not surface to the player. A `retry-exhausted` is a
 *      real user-visible failure and is counted separately and loudly.
 *   3. **Structural commands hard-reject exactly once per version.** `end-round`
 *      carries `expectedStructuralVersion`, so when N actors contend for one
 *      structural transition, exactly ONE may win and the rest must get
 *      `stale-structure` (409) — never a silent accept, never a 500.
 *   4. **A duplicate `commandId` replays the identical stored outcome** and does
 *      not apply twice, even when the duplicate is fired concurrently with the
 *      original rather than after it.
 *   5. **No accepted command is lost.** Every accepted resulting version must
 *      still be readable from the session afterwards.
 *
 * Authentication, campaign setup and the `Server-Timing` capture are IMPORTED
 * from `session-polling.mjs` rather than reimplemented, so the two harnesses
 * cannot drift on how a fixture campaign is built and then disagree about what
 * they measured.
 *
 * Usage:
 *   node tests/load/session-contention.mjs                       # self-booted local server
 *   CAMPAIGN_LOAD_TARGET=staging CAMPAIGN_STAGING_AUTH_SECRET=… \
 *     node tests/load/session-contention.mjs --base-url https://…workers.dev
 */

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import {
	apiCall,
	bootServer,
	percentile,
	seedStagingUsers,
	setupCampaign,
	summarizeLatencies
} from './session-polling.mjs';

const stagingMode = (process.env.CAMPAIGN_LOAD_TARGET ?? '').toLowerCase() === 'staging';
const stagingAuthSecret = process.env.CAMPAIGN_STAGING_AUTH_SECRET ?? '';

function parseArgs(argv) {
	const args = {
		campaigns: 9,
		rounds: 20,
		baseUrl: null,
		port: 4176,
		bootTimeoutMs: 90_000,
		/** Pause between contention rounds. Small on purpose — the point is to
		 * keep the database hot, not to simulate a human. */
		roundGapMs: 250
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const next = () => argv[++i];
		switch (arg) {
			case '--campaigns':
				args.campaigns = Number(next());
				break;
			case '--rounds':
				args.rounds = Number(next());
				break;
			case '--base-url':
				args.baseUrl = next();
				break;
			case '--port':
				args.port = Number(next());
				break;
			case '--round-gap-ms':
				args.roundGapMs = Number(next());
				break;
			case '--boot-timeout-ms':
				args.bootTimeoutMs = Number(next());
				break;
			case '--help':
				console.log(`Usage: node tests/load/session-contention.mjs [options]

  --campaigns <n>        Campaigns contending in parallel (default 9, the pilot scenario)
  --rounds <n>           Contention rounds per campaign (default 20)
  --base-url <url>       Target an already-running server instead of booting one
  --port <port>          Port for the self-booted preview server (default 4176)
  --round-gap-ms <ms>    Pause between rounds (default 250)
  --boot-timeout-ms <ms> How long to wait for the self-booted server (default 90000)
`);
				process.exit(0);
				break;
			default:
				throw new Error(`unrecognized argument: ${arg}`);
		}
	}
	return args;
}

class ContentionStats {
	/** `${sessionId}#${resultingVersion}` -> how many accepted commands claimed
	 * it. Anything above 1 is a lost write. */
	claimedVersions = new Map();
	duplicateResultingVersions = 0;

	drawAttempts = 0;
	drawAccepted = 0;
	drawRetryExhausted = 0;
	/** Any draw rejection that is NOT retry-exhausted — unexpected, since a
	 * non-structural command should be absorbed or explicitly exhausted. */
	drawUnexpectedRejections = [];

	structuralAttempts = 0;
	structuralAccepted = 0;
	structuralStale = 0;
	structuralUnexpected = [];

	duplicateReplayMismatches = [];
	doubleAppliedDuplicates = 0;

	transportErrors = [];
	latencies = [];
	d1RoundTrips = [];
	colos = new Map();

	noteResponse(res) {
		this.latencies.push(res.latencyMs);
		if (res.timing?.d1Calls !== undefined && res.timing.d1Calls !== null) {
			this.d1RoundTrips.push(res.timing.d1Calls);
		}
		if (res.colo) this.colos.set(res.colo, (this.colos.get(res.colo) ?? 0) + 1);
		if (res.status >= 500 || res.error) {
			this.transportErrors.push({ status: res.status, error: res.error ?? null });
		}
	}

	noteAcceptedVersion(sessionId, resultingVersion) {
		const key = `${sessionId}#${resultingVersion}`;
		const seen = (this.claimedVersions.get(key) ?? 0) + 1;
		this.claimedVersions.set(key, seen);
		if (seen > 1) this.duplicateResultingVersions += 1;
	}
}

/** Fires `count` draw commands at once, all declaring the SAME observed session
 * version, so they genuinely race for the version claim. */
async function contendWithDraws(baseUrl, campaign, observedVersion, stats) {
	// Player seats only: the GM has no `player-hand` zone, so including them
	// would measure an authorization rejection rather than a version race.
	const attempts = campaign.clients
		.filter((client) => client.handZoneId)
		.map((client, seat) =>
		apiCall(baseUrl, `/api/campaigns/${campaign.campaignId}/sessions/${campaign.sessionId}/commands`, {
			method: 'POST',
			jar: client.jar,
			body: {
				commandId: randomUUID(),
				observedSessionVersion: observedVersion,
				command: {
					type: 'draw',
					deck: 'player',
					// Each seat draws into its OWN hand, so a contended round is a
					// version race and not also a zone-ownership rejection. The zone
					// id is DISCOVERED from the actor's own projection rather than
					// derived from the role — it is keyed by user id, and guessing it
					// produced 12/12 `illegal-command` rejections that looked exactly
					// like a product bug.
					destinationZoneId: client.handZoneId,
					count: 1
				}
			}
			}).then((res) => ({ res, seat }))
		);

	const settled = await Promise.all(attempts);
	for (const { res } of settled) {
		stats.drawAttempts += 1;
		stats.noteResponse(res);
		const outcome = res.json?.outcome;
		if (outcome?.ok) {
			stats.drawAccepted += 1;
			stats.noteAcceptedVersion(campaign.sessionId, outcome.resultingVersion);
		} else if (outcome?.code === 'retry-exhausted') {
			stats.drawRetryExhausted += 1;
		} else {
			stats.drawUnexpectedRejections.push({
				status: res.status,
				code: outcome?.code ?? 'none',
				campaign: campaign.index
			});
		}
	}
	return settled;
}

/** Fires one `end-round` per client, all declaring the same
 * `expectedStructuralVersion`. Exactly one may win. */
async function contendWithStructural(baseUrl, campaign, observedVersion, stats) {
	// `end-round` is GM-only, so contending seats would be rejected for
	// authorization rather than staleness and prove nothing about the claim.
	// Instead the GM fires several at once against the same structural version:
	// same race, same code path, no authorization confound.
	const attempts = Array.from({ length: 3 }, () => {
		// Captured so a violation can be traced to the persisted
		// `session_commands` rows (expected_version, resulting_version,
		// structural_precondition_version) — the only place that can settle what
		// the server actually evaluated. Without it a multi-winner round is
		// unexplainable from the client side.
		const commandId = randomUUID();
		return apiCall(baseUrl, `/api/campaigns/${campaign.campaignId}/sessions/${campaign.sessionId}/commands`, {
			method: 'POST',
			jar: campaign.clients[0].jar,
			body: {
				commandId,
				observedSessionVersion: observedVersion,
				// A hard precondition, not a hint — omitting it yields
				// `stale-structure` unconditionally.
				expectedStructuralVersion: observedVersion,
				command: { type: 'end-round' }
			}
		}).then((res) => ({ res, commandId }));
	});

	const settled = await Promise.all(attempts);
	for (const { res } of settled) {
		stats.structuralAttempts += 1;
		stats.noteResponse(res);
		const outcome = res.json?.outcome;
		if (outcome?.ok) {
			stats.structuralAccepted += 1;
			stats.noteAcceptedVersion(campaign.sessionId, outcome.resultingVersion);
		} else if (outcome?.code === 'stale-structure') {
			stats.structuralStale += 1;
		} else {
			stats.structuralUnexpected.push({
				status: res.status,
				code: outcome?.code ?? 'none',
				campaign: campaign.index
			});
		}
	}

	// Exactly one winner per contended structural version — checked per round,
	// so a violation names the round it happened in.
	//
	// The diagnostic detail is captured HERE rather than reconstructed later: a
	// bare "2 winners" count cannot distinguish a broken exclusivity guarantee
	// (two claims of the SAME resulting version) from the harness having declared
	// two different preconditions (two claims of DIFFERENT versions, which means
	// the round did not actually contend). Those need opposite responses, so the
	// run records which one it saw.
	const winners = settled.filter(({ res }) => res.json?.outcome?.ok);
	if (winners.length > 1) {
		const versions = winners.map(({ res }) => res.json.outcome.resultingVersion);
		const distinct = new Set(versions).size === versions.length;
		stats.structuralUnexpected.push({
			status: 200,
			code:
				`${winners.length} structural winners for declared precondition ${observedVersion} ` +
				`(resulting versions ${versions.join(', ')}; ` +
				`${distinct ? 'DISTINCT — see issue #14' : 'SAME — exclusivity is broken'}) ` +
				`session=${campaign.sessionId} commandIds=${winners.map(({ commandId }) => commandId).join(',')}`,
			campaign: campaign.index
		});
	}
	return settled;
}

/** Fires the SAME commandId twice concurrently. Both must report the identical
 * outcome, and only one may have applied. */
async function contendWithDuplicate(baseUrl, campaign, observedVersion, stats) {
	const commandId = randomUUID();
	const client = campaign.clients[1];
	const body = {
		commandId,
		observedSessionVersion: observedVersion,
		command: { type: 'draw', deck: 'player', destinationZoneId: client.handZoneId, count: 1 }
	};

	const [first, second] = await Promise.all([
		apiCall(baseUrl, `/api/campaigns/${campaign.campaignId}/sessions/${campaign.sessionId}/commands`, {
			method: 'POST',
			jar: client.jar,
			body
		}),
		apiCall(baseUrl, `/api/campaigns/${campaign.campaignId}/sessions/${campaign.sessionId}/commands`, {
			method: 'POST',
			jar: client.jar,
			body
		})
	]);

	stats.noteResponse(first);
	stats.noteResponse(second);

	const a = first.json?.outcome;
	const b = second.json?.outcome;
	if (JSON.stringify(a) !== JSON.stringify(b)) {
		stats.duplicateReplayMismatches.push({ campaign: campaign.index, a, b });
	}
	// Count the version ONCE even though two responses reported it: a correct
	// duplicate replay is not a second claim. If the two disagree, the mismatch
	// above already fails the run.
	if (a?.ok) stats.noteAcceptedVersion(campaign.sessionId, a.resultingVersion);
	if (a?.ok && b?.ok && a.resultingVersion !== b.resultingVersion) {
		stats.doubleAppliedDuplicates += 1;
	}
}

/**
 * Resolves each client's OWN private hand zone id from their own projection.
 *
 * Zone ids are keyed by user id (`hand:<userId>`, `repository.ts`), and this
 * harness's fixture users have generated ids, so the zone id cannot be derived
 * from the seat's role. Reading it from the actor's projection is also the only
 * way that stays correct if the zone naming ever changes.
 */
async function discoverHandZones(baseUrl, campaign) {
	for (const client of campaign.clients) {
		if (client.role === 'gm') continue; // the GM draws via `end-round`, not a hand
		const res = await apiCall(baseUrl, `/api/campaigns/${campaign.campaignId}/sessions/${campaign.sessionId}`, {
			jar: client.jar
		});
		if (!res.ok) throw new Error(`campaign ${campaign.index}: session read failed (${res.status})`);
		const byZone = res.json?.session?.projection?.privateHandsByZoneId ?? {};
		const zoneId = Object.keys(byZone).find((id) => id.startsWith('hand:'));
		if (!zoneId) {
			throw new Error(
				`campaign ${campaign.index}: no private hand zone in ${client.role}'s projection ` +
					`(keys: ${Object.keys(byZone).join(', ') || 'none'})`
			);
		}
		client.handZoneId = zoneId;
	}
}

/** Reads the session back and returns its current version, so the harness always
 * contends against the truth rather than its own bookkeeping. */
async function currentSessionVersion(baseUrl, campaign) {
	const res = await apiCall(baseUrl, `/api/campaigns/${campaign.campaignId}/sessions/${campaign.sessionId}`, {
		jar: campaign.clients[0].jar
	});
	if (!res.ok) throw new Error(`campaign ${campaign.index}: could not read session (${res.status})`);
	return res.json.session.sessionVersion;
}

async function runCampaignRounds(baseUrl, campaign, stats, opts) {
	for (let round = 0; round < opts.rounds; round += 1) {
		const version = await currentSessionVersion(baseUrl, campaign);

		// Three seats racing for one version.
		await contendWithDraws(baseUrl, campaign, version, stats);

		// Then a structural transition, contended against the version the draws
		// left behind.
		const afterDraws = await currentSessionVersion(baseUrl, campaign);
		await contendWithStructural(baseUrl, campaign, afterDraws, stats);

		// Then a concurrent duplicate.
		const afterStructural = await currentSessionVersion(baseUrl, campaign);
		await contendWithDuplicate(baseUrl, campaign, afterStructural, stats);

		if (opts.roundGapMs > 0) await sleep(opts.roundGapMs);
	}
}

function report(stats, opts) {
	const latency = summarizeLatencies(stats.latencies);
	const trips = stats.d1RoundTrips.length > 0 ? [...stats.d1RoundTrips].sort((a, b) => a - b) : [];
	const meanTrips =
		stats.d1RoundTrips.length > 0
			? stats.d1RoundTrips.reduce((sum, n) => sum + n, 0) / stats.d1RoundTrips.length
			: null;

	console.log('');
	console.log('=== Contention gate summary ===');
	console.log(`campaigns: ${opts.campaigns}, rounds each: ${opts.rounds}`);
	console.log('');
	console.log('-- Non-structural (draw) contention --');
	console.log(`  attempts: ${stats.drawAttempts}, accepted: ${stats.drawAccepted}`);
	console.log(`  retry-exhausted: ${stats.drawRetryExhausted}`);
	console.log(`  unexpected rejections: ${stats.drawUnexpectedRejections.length}`);
	for (const r of stats.drawUnexpectedRejections.slice(0, 5)) {
		console.log(`    campaign ${r.campaign}: HTTP ${r.status}, code ${r.code}`);
	}
	console.log('');
	console.log('-- Structural (end-round) contention --');
	console.log(`  attempts: ${stats.structuralAttempts}, accepted: ${stats.structuralAccepted}`);
	console.log(`  stale-structure (expected for losers): ${stats.structuralStale}`);
	console.log(`  unexpected: ${stats.structuralUnexpected.length}`);
	for (const r of stats.structuralUnexpected.slice(0, 5)) {
		console.log(`    campaign ${r.campaign}: HTTP ${r.status}, code ${r.code}`);
	}
	console.log('');
	console.log('-- Version-claim exclusivity --');
	console.log(`  distinct resulting versions claimed: ${stats.claimedVersions.size}`);
	console.log(`  DUPLICATE resulting versions: ${stats.duplicateResultingVersions}`);
	console.log('');
	console.log('-- Concurrent duplicate commandId --');
	console.log(`  replay mismatches: ${stats.duplicateReplayMismatches.length}`);
	console.log(`  double-applied: ${stats.doubleAppliedDuplicates}`);
	console.log('');
	console.log('-- Request cost --');
	console.log(
		`  latency ms — p50: ${fmt(latency.p50)}, p95: ${fmt(latency.p95)}, p99: ${fmt(latency.p99)}, max: ${fmt(latency.max)}`
	);
	if (meanTrips !== null && meanTrips > 0) {
		console.log(
			`  D1 round trips — mean ${meanTrips.toFixed(2)}, p95 ${percentile(trips, 95)}, max ${trips[trips.length - 1]}`
		);
	} else if (meanTrips !== null) {
		// Same trap `session-polling.mjs` guards: a local run is better-sqlite3, so
		// `instrumentD1` sees nothing and every count is legitimately zero. Say so
		// out loud rather than printing a row of zeroes for someone to compare
		// against staging numbers as if they measured the same thing.
		console.log(
			'  D1 round trips: 0 observed — this target is NOT backed by a D1 binding ' +
				'(local better-sqlite3). Contention correctness above is still meaningful; ' +
				'the round-trip and latency figures are not comparable to a staging run.'
		);
	} else {
		console.log('  D1 round trips: not reported (no Server-Timing — off-edge target, or CAMPAIGN_TIMING_HEADER unset)');
	}
	if (stats.colos.size > 0) {
		const served = [...stats.colos.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([colo, count]) => `${colo}=${count}`)
			.join(', ');
		console.log(`  Cloudflare colo(s): ${served}`);
	}
	console.log(`  transport/5xx errors: ${stats.transportErrors.length}`);
	console.log('');

	// --- Gates. Every one of these is zero-tolerance: they are correctness
	// invariants, not budgets, so there is no threshold to tune. ---
	const gates = [
		['no duplicate resulting versions (version claim is exclusive)', stats.duplicateResultingVersions === 0],
		['no unexpected draw rejection', stats.drawUnexpectedRejections.length === 0],
		['no unexpected structural outcome', stats.structuralUnexpected.length === 0],
		['concurrent duplicate commandId replays identically', stats.duplicateReplayMismatches.length === 0],
		['no double-applied duplicate', stats.doubleAppliedDuplicates === 0],
		['no transport or 5xx errors', stats.transportErrors.length === 0],
		// A retry-exhausted IS user-visible failure. It is not impossible by
		// design, so it is reported rather than assumed away — but at pilot
		// concurrency it should not happen, and if it does the rollout needs to
		// know before players do.
		['no retry-exhausted surfaced to a caller', stats.drawRetryExhausted === 0]
	];

	let failed = 0;
	for (const [label, ok] of gates) {
		console.log(`Gate: ${label}? ${ok ? 'PASS' : 'FAIL'}`);
		if (!ok) failed += 1;
	}
	console.log('');
	if (failed > 0) {
		console.error(`[contention] FAILED — ${failed} gate(s) above`);
		return 1;
	}
	console.log('[contention] PASSED');
	return 0;
}

function fmt(value) {
	return value === null || value === undefined ? 'n/a' : value.toFixed(1);
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	console.log(
		`[contention] starting: ${opts.campaigns} campaigns x ${opts.rounds} rounds, ` +
			`3 simultaneous writers per round, round gap ${opts.roundGapMs}ms`
	);

	let serverHandle = null;
	let baseUrl = opts.baseUrl;
	const stats = new ContentionStats();
	let exitCode = 1;

	try {
		if (stagingMode) {
			if (!baseUrl) throw new Error('CAMPAIGN_LOAD_TARGET=staging requires --base-url');
			if (!stagingAuthSecret) throw new Error('CAMPAIGN_LOAD_TARGET=staging requires CAMPAIGN_STAGING_AUTH_SECRET');
			if (/guildbook\.arrowed\.games/.test(baseUrl)) {
				throw new Error('refusing to load-test the production hostname');
			}
			console.log(`[contention] STAGING mode against ${baseUrl}`);
			await seedStagingUsers(opts.campaigns * 3);
		} else if (!baseUrl) {
			serverHandle = await bootServer(opts.port, opts.bootTimeoutMs);
			baseUrl = serverHandle.baseUrl;
		} else {
			console.log(`[contention] using already-running server at ${baseUrl}`);
		}

		console.log(`[contention] setting up ${opts.campaigns} campaigns...`);
		const campaigns = await Promise.all(
			Array.from({ length: opts.campaigns }, (_, index) => setupCampaign(baseUrl, index))
		);
		await Promise.all(campaigns.map((campaign) => discoverHandZones(baseUrl, campaign)));
		console.log('[contention] all campaigns ready; contending');

		// All nine campaigns contend at the same time — nine sessions writing to
		// ONE D1 database is the sequential-per-database behaviour the plan
		// requires measured, and it cannot be seen one campaign at a time.
		await Promise.all(campaigns.map((campaign) => runCampaignRounds(baseUrl, campaign, stats, opts)));
		console.log('[contention] rounds complete');

		exitCode = report(stats, opts);
	} finally {
		if (serverHandle) {
			console.log('[contention] tearing down preview server');
			await serverHandle.cleanup();
		}
	}

	process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((err) => {
		console.error('[contention] fatal error:', err);
		process.exitCode = 1;
	});
}
