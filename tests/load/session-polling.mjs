#!/usr/bin/env node
/**
 * Task 8 pilot load gate (spec Increment 2, controller amendments 1-2).
 *
 * Simulates the allowlisted pilot's steady state: nine campaigns, three
 * authenticated polling clients each (one GM, two players), all polling
 * `/api/campaigns/[id]/sync` at the table's production cadence (~1s +
 * 0-150ms jitter, matching `campaign-session.svelte.ts`). While polling
 * runs, each campaign's GM periodically issues an `end-round` command (the
 * only command that is GM-only, always legal, and never exhausts a deck) so
 * the harness can measure how long an accepted public change takes to reach
 * every OTHER client's next poll — the two-second visibility budget Task 7
 * fixed round 1 tuned the cursor-hint TTL to meet.
 *
 * Plain Node, no dependencies beyond the runtime's built-in fetch/undici
 * (controller amendment on the brief: "no new dependencies unless truly
 * necessary").
 *
 * Auth (amendment 1): mirrors playwright.config.ts's webServer — a
 * production build served by `vite preview`, booted with
 * NODE_ENV=development, AUTH_DEV_LOGIN=true, CAMPAIGNS_ENABLED=true, and a
 * fixture-only SQLite DB — and authenticates fixture users through the dev
 * Credentials provider's callback endpoint directly (no browser). See
 * `docs/operations/campaign-pilot.md` for why this differs from the
 * allowlist path production actually gates on.
 *
 * D1 read/write counts: this harness talks HTTP to a Node/better-sqlite3
 * preview server, not a live D1 binding, so it cannot instrument literal D1
 * read/write counts. The "reads"/"writes" reported below are an
 * HTTP-observable proxy — every 200/204 sync response is one read, and every
 * command *attempt* (accepted or rejected) is also counted as one read,
 * since `executeCommand` always loads current session state to evaluate a
 * command before it can decide to accept or reject it; every *accepted*
 * command additionally counts as one write — documented as such in the
 * completion record, never presented as measured D1 metrics.
 *
 * Self-measurement (diagnostic instrumentation added after the first gate
 * run failed at max=5477ms with uniformly low poll latency — see
 * `docs/superpowers/2026-07-18-campaigns-increment-2-completion.md` §7 for
 * the full incident): this harness runs every poll loop, command loop, and
 * the event-loop-lag sampler itself as concurrent async tasks inside ONE
 * Node process. If that process's own event loop falls behind (GC pause,
 * a burst of synchronous JSON work, timer contention), a client's `sleep()`
 * wakes up late — which inflates measured "time to visible" without any
 * real server or network delay, and is invisible to `apiCall`'s latency
 * timer (it only starts once `fetch()` actually runs, not when the client
 * *meant* to run it). `startEventLoopLagSampler` below measures exactly
 * that drift directly, every observation is logged individually with a
 * timestamp (not just aggregated), and `report()` cross-references the two
 * so a harness stall is visible in the run's own output instead of merely
 * inferred after the fact. This is not a "correction" applied to
 * timestamps — nothing here adjusts a measured value; it only reports
 * whether the harness itself was keeping up at the same moments the
 * outliers occurred.
 */

import { spawn } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { rm } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
	const args = {
		durationSec: 600,
		campaigns: 9,
		clientsPerCampaign: 3,
		pollIntervalMs: 1000,
		jitterMs: 150,
		commandIntervalMs: 5000,
		baseUrl: null,
		port: 4174,
		bootTimeoutMs: 90_000
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const next = () => argv[++i];
		switch (arg) {
			case '--duration':
				args.durationSec = Number(next());
				break;
			case '--base-url':
				args.baseUrl = next();
				break;
			case '--port':
				args.port = Number(next());
				break;
			case '--campaigns':
				args.campaigns = Number(next());
				break;
			case '--command-interval-ms':
				args.commandIntervalMs = Number(next());
				break;
			case '--poll-interval-ms':
				args.pollIntervalMs = Number(next());
				break;
			case '--jitter-ms':
				args.jitterMs = Number(next());
				break;
			case '--boot-timeout-ms':
				args.bootTimeoutMs = Number(next());
				break;
			case '--help':
				printHelp();
				process.exit(0);
				break;
			default:
				throw new Error(`unrecognized argument: ${arg}`);
		}
	}
	if (!Number.isFinite(args.durationSec) || args.durationSec <= 0) {
		throw new Error('--duration must be a positive number of seconds');
	}
	return args;
}

function printHelp() {
	console.log(`Usage: node tests/load/session-polling.mjs [options]

  --duration <seconds>          Load-window length (default 600 = 10 minutes)
  --base-url <url>              Poll an already-running server instead of booting one
  --port <port>                 Port for the self-booted preview server (default 4174)
  --campaigns <n>                Number of campaigns to simulate (default 9)
  --command-interval-ms <ms>    How often each campaign's GM triggers a visible event (default 5000)
  --poll-interval-ms <ms>       Base poll cadence (default 1000, matches the table UI)
  --jitter-ms <ms>              Extra random jitter added to each poll (default 150)
  --boot-timeout-ms <ms>        How long to wait for the self-booted server to answer (default 90000)
`);
}

// ---------------------------------------------------------------------------
// Self-booted preview server (amendment 1: mirrors playwright.config.ts)
// ---------------------------------------------------------------------------

const RUN_ID = `${Date.now()}-${randomBytes(3).toString('hex')}`;

async function bootServer(port, bootTimeoutMs) {
	const databaseUrl = `.tmp/guild-book-load-${RUN_ID}.db`;
	const env = {
		...process.env,
		NODE_ENV: 'development',
		AUTH_DEV_LOGIN: 'true',
		AUTH_DEV_AUTOLOGIN: 'false',
		AUTH_SECRET: process.env.AUTH_SECRET ?? 'guild-book-load-secret',
		AUTH_URL: `http://127.0.0.1:${port}`,
		ORIGIN: `http://127.0.0.1:${port}`,
		CAMPAIGNS_ENABLED: 'true',
		CAMPAIGN_INVITE_SECRET: process.env.CAMPAIGN_INVITE_SECRET ?? 'guild-book-load-invite-secret',
		DATABASE_URL: databaseUrl
	};

	console.log(`[load] seeding fixture DB at ${databaseUrl}`);
	await runToCompletion('node', ['scripts/e2e/setup-db.mjs'], env);

	console.log('[load] building (Node preview target, no ADAPTER override)');
	await runToCompletion('npm', ['run', 'build'], env);

	console.log(`[load] starting preview server on 127.0.0.1:${port}`);
	const child = spawn('npm', ['run', 'preview', '--', '--host', '127.0.0.1', '--port', String(port)], {
		env,
		detached: true,
		stdio: ['ignore', 'pipe', 'pipe']
	});
	child.stdout.on('data', (chunk) => process.stdout.write(`[preview] ${chunk}`));
	child.stderr.on('data', (chunk) => process.stderr.write(`[preview] ${chunk}`));

	const baseUrl = `http://127.0.0.1:${port}`;

	// Review round 1: if the server never comes up, the previous version left
	// `child` running with nothing left holding a reference to kill it — an
	// un-unref'd child process keeps the event loop alive on its own, so the
	// script hung instead of exiting non-zero (exactly wrong for a nohup'd
	// background run). Kill it here, before rethrowing, so a boot failure
	// always terminates cleanly.
	try {
		await waitForReady(baseUrl, bootTimeoutMs);
	} catch (err) {
		console.error('[load] preview server never became ready — killing it before exiting');
		await killChildAndCleanup(child, databaseUrl);
		throw err;
	}
	console.log('[load] preview server is ready');

	return {
		baseUrl,
		cleanup: () => killChildAndCleanup(child, databaseUrl)
	};
}

/** Kills the preview server (SIGTERM, then SIGKILL if it's still alive
 * 500ms later) and removes its per-run fixture DB files. Shared by both the
 * success-path `cleanup()` and the boot-failure path above so there is one
 * place that knows how to tear this down. */
async function killChildAndCleanup(child, databaseUrl) {
	if (child.exitCode === null && !child.killed) {
		try {
			process.kill(-child.pid, 'SIGTERM');
		} catch {
			try {
				child.kill('SIGTERM');
			} catch {
				// already gone
			}
		}
		await sleep(500);
		try {
			if (child.exitCode === null) process.kill(-child.pid, 'SIGKILL');
		} catch {
			// already gone
		}
	}

	// Review round 1 minor: the per-run fixture DB was never cleaned up —
	// harmless individually, but a long-lived CI runner would accumulate one
	// per invocation. better-sqlite3's WAL mode also leaves -shm/-wal
	// sidecar files alongside the main db file.
	for (const suffix of ['', '-shm', '-wal']) {
		await rm(`${databaseUrl}${suffix}`, { force: true }).catch(() => {});
	}
}

function runToCompletion(command, args, env) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { env, stdio: 'inherit' });
		child.on('error', reject);
		child.on('exit', (code) => {
			if (code === 0) resolve();
			else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
		});
	});
}

async function waitForReady(baseUrl, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let lastError = null;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${baseUrl}/login`);
			if (res.status === 200) return;
			lastError = new Error(`unexpected status ${res.status}`);
		} catch (err) {
			lastError = err;
		}
		await sleep(500);
	}
	throw new Error(`preview server never became ready at ${baseUrl}: ${lastError?.message ?? 'unknown error'}`);
}

// ---------------------------------------------------------------------------
// HTTP + auth helpers
// ---------------------------------------------------------------------------

function newJar() {
	return new Map();
}

function cookieHeader(jar) {
	return Array.from(jar.entries())
		.map(([name, value]) => `${name}=${value}`)
		.join('; ');
}

function updateJar(jar, res) {
	const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
	for (const raw of setCookies) {
		const [pair] = raw.split(';');
		const eq = pair.indexOf('=');
		if (eq === -1) continue;
		const name = pair.slice(0, eq).trim();
		const value = pair.slice(eq + 1).trim();
		if (/max-age=0/i.test(raw) || value === '') jar.delete(name);
		else jar.set(name, value);
	}
}

/** One authenticated + timed HTTP call. Never throws — network failures and
 * non-2xx statuses are both reported through the returned envelope so
 * callers can record them as measurement data, not crash the harness. */
async function apiCall(baseUrl, path, { method = 'GET', jar, body } = {}) {
	const headers = { Origin: baseUrl, Cookie: cookieHeader(jar) };
	if (body !== undefined) headers['Content-Type'] = 'application/json';
	const start = performance.now();
	let res;
	try {
		res = await fetch(`${baseUrl}${path}`, {
			method,
			headers,
			body: body !== undefined ? JSON.stringify(body) : undefined
		});
	} catch (err) {
		return { ok: false, status: 0, latencyMs: performance.now() - start, json: null, error: err };
	}
	const latencyMs = performance.now() - start;
	updateJar(jar, res);
	let json = null;
	if (res.status !== 204) {
		try {
			json = await res.json();
		} catch {
			// non-JSON body; leave json null
		}
	}
	return { ok: res.ok, status: res.status, latencyMs, json, error: null };
}

async function login(baseUrl, jar, email, name) {
	const res = await fetch(`${baseUrl}/auth/callback/credentials`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			Origin: baseUrl,
			'X-Auth-Return-Redirect': '1'
		},
		body: new URLSearchParams({ email, name, callbackUrl: `${baseUrl}/campaigns` })
	});
	updateJar(jar, res);
	if (!res.ok) throw new Error(`login failed for ${email}: ${res.status}`);
	if (!jar.has('authjs.session-token')) {
		throw new Error(`login for ${email} did not yield a session cookie`);
	}
}

let identitySequence = 0;
function uniqueEmail(role) {
	identitySequence += 1;
	return `${role}-${RUN_ID}-${process.pid}-${identitySequence}@example.test`;
}

// ---------------------------------------------------------------------------
// Campaign fixture setup
// ---------------------------------------------------------------------------

async function setupCampaign(baseUrl, index) {
	const gmJar = newJar();
	const playerAJar = newJar();
	const playerBJar = newJar();

	await login(baseUrl, gmJar, uniqueEmail('gm'), `Load GM ${index}`);
	await login(baseUrl, playerAJar, uniqueEmail('player-a'), `Load Player A ${index}`);
	await login(baseUrl, playerBJar, uniqueEmail('player-b'), `Load Player B ${index}`);

	const created = await apiCall(baseUrl, '/api/campaigns', {
		method: 'POST',
		jar: gmJar,
		body: { name: `Load Test Campaign ${index} (${RUN_ID})` }
	});
	if (!created.ok) throw new Error(`campaign ${index}: create failed (${created.status})`);
	const campaignId = created.json.campaign.id;
	const inviteToken = created.json.inviteToken;

	for (const jar of [playerAJar, playerBJar]) {
		const joined = await apiCall(baseUrl, `/api/campaigns/join/${inviteToken}`, {
			method: 'POST',
			jar,
			body: { joinWithoutCharacter: true }
		});
		if (!joined.ok) throw new Error(`campaign ${index}: join failed (${joined.status})`);
	}

	const started = await apiCall(baseUrl, `/api/campaigns/${campaignId}/sessions`, {
		method: 'POST',
		jar: gmJar,
		body: {}
	});
	if (!started.ok) throw new Error(`campaign ${index}: session start failed (${started.status})`);
	const sessionId = started.json.sessionId;
	const initialCursor = started.json.session.campaignCursor;
	const initialVersion = started.json.session.sessionVersion;

	return {
		index,
		campaignId,
		sessionId,
		clients: [
			{ role: 'gm', jar: gmJar, cursor: initialCursor, version: initialVersion },
			{ role: 'player-a', jar: playerAJar, cursor: initialCursor, version: initialVersion },
			{ role: 'player-b', jar: playerBJar, cursor: initialCursor, version: initialVersion }
		],
		// Queue of in-flight visibility probes: { targetCursor, acceptedAt, remaining: Set<client> }
		pendingEvents: []
	};
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

class Stats {
	pollTotal = 0;
	poll200 = 0;
	poll204 = 0;
	pollErrors = 0;
	pollLatencies = [];

	commandTotal = 0;
	commandAccepted = 0;
	commandErrors = 0;
	commandLatencies = [];

	visibilityLatencies = [];
	// Per-observation record, not just the aggregate array above — this is
	// what makes the >2000ms/>1500ms breakdown and timestamp correlation
	// possible after the run, instead of only percentiles.
	visibilityObservations = [];

	// { ts: epoch ms, driftMs } — one per event-loop-lag sample. Populated by
	// startEventLoopLagSampler.
	loopLagSamples = [];

	recordPoll(res) {
		this.pollTotal += 1;
		if (res.status === 200) {
			this.poll200 += 1;
			this.pollLatencies.push(res.latencyMs);
		} else if (res.status === 204) {
			this.poll204 += 1;
			this.pollLatencies.push(res.latencyMs);
		} else {
			this.pollErrors += 1;
		}
	}

	recordCommand(res) {
		this.commandTotal += 1;
		this.commandLatencies.push(res.latencyMs);
		if (res.ok && res.status === 200 && res.json?.outcome?.ok) this.commandAccepted += 1;
		else this.commandErrors += 1;
	}

	recordVisibility(ms, meta) {
		this.visibilityLatencies.push(ms);
		const ts = Date.now();
		this.visibilityObservations.push({ ts, latencyMs: ms, ...meta });
		console.log(
			`[vis] ts=${new Date(ts).toISOString()} campaign=${meta.campaignIndex} role=${meta.role} latencyMs=${ms.toFixed(1)}`
		);
	}

	recordLoopLag(driftMs) {
		const ts = Date.now();
		this.loopLagSamples.push({ ts, driftMs });
		// Sparse on purpose — logging every ~50ms sample for 10 minutes would
		// flood the log with ~12,000 near-zero lines. Anything past this
		// threshold is already an anomaly worth a timestamped line; the full
		// sample array (used for percentiles + correlation) is kept in memory
		// regardless of whether it crossed the threshold.
		if (driftMs > 50) {
			console.log(`[lag] ts=${new Date(ts).toISOString()} driftMs=${driftMs.toFixed(1)}`);
		}
	}
}

/** Measures how far the harness's own event loop falls behind a nominal
 * `intervalMs` tick — the direct signal for "was this Node process itself
 * stalled" (see the file header's Self-measurement note). Not a correction
 * applied to any other timestamp; a standalone diagnostic. */
function startEventLoopLagSampler(stats, intervalMs = 50) {
	let last = performance.now();
	const timer = setInterval(() => {
		const now = performance.now();
		const driftMs = now - last - intervalMs;
		last = now;
		stats.recordLoopLag(Math.max(0, driftMs));
	}, intervalMs);
	timer.unref?.();
	return () => clearInterval(timer);
}

function percentile(sortedValues, p) {
	if (sortedValues.length === 0) return null;
	const idx = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1));
	return sortedValues[idx];
}

function summarizeLatencies(values) {
	if (values.length === 0) return { count: 0, p50: null, p95: null, p99: null, max: null };
	const sorted = [...values].sort((a, b) => a - b);
	return {
		count: sorted.length,
		p50: percentile(sorted, 50),
		p95: percentile(sorted, 95),
		p99: percentile(sorted, 99),
		max: sorted[sorted.length - 1]
	};
}

// ---------------------------------------------------------------------------
// Poll + command loops
// ---------------------------------------------------------------------------

function resolveVisibility(campaign, client, stats) {
	const now = Date.now();
	for (const event of campaign.pendingEvents) {
		if (client.cursor >= event.targetCursor && event.remaining.has(client)) {
			event.remaining.delete(client);
			stats.recordVisibility(now - event.acceptedAt, { campaignIndex: campaign.index, role: client.role });
		}
	}
	campaign.pendingEvents = campaign.pendingEvents.filter((event) => event.remaining.size > 0);
}

/** `initialDelayMs`: this client's evenly-spread offset into the first poll
 * cadence window (see the file header's Self-measurement note and
 * `assignPollStartOffsets` below) — without it, every client's first poll
 * fires within the same ~150ms jitter window right after setup, which is
 * itself a synchronized burst the harness never needs to reproduce again
 * (later cycles re-draw jitter independently and naturally desynchronize),
 * but which can still distort the very first cycle's timing. */
async function pollLoop(baseUrl, campaign, client, stats, endTime, opts, initialDelayMs) {
	await sleep(initialDelayMs);
	while (Date.now() < endTime) {
		const jitter = Math.random() * opts.jitterMs;
		await sleep(opts.pollIntervalMs + jitter);
		if (Date.now() >= endTime) break;

		const res = await apiCall(
			baseUrl,
			`/api/campaigns/${campaign.campaignId}/sync?after=${client.cursor}&version=${client.version}`,
			{ jar: client.jar }
		);
		stats.recordPoll(res);

		if (res.status === 200 && res.json) {
			client.cursor = res.json.cursor;
			if (res.json.session) client.version = res.json.session.sessionVersion;
			resolveVisibility(campaign, client, stats);
		}
	}
}

/** Evenly spreads N clients across one poll cadence window
 * (`[0, pollIntervalMs)`), deterministically (not randomly) so a rerun's
 * initial spread is reproducible. */
function assignPollStartOffsets(clientCount, pollIntervalMs) {
	return Array.from({ length: clientCount }, (_, i) => Math.floor((i / clientCount) * pollIntervalMs));
}

async function commandLoop(baseUrl, campaign, stats, endTime, opts) {
	// Stagger campaign start so all nine don't fire their first command in
	// the same tick.
	await sleep(campaign.index * 250);

	while (Date.now() < endTime) {
		await sleep(opts.commandIntervalMs);
		if (Date.now() >= endTime) break;

		const gm = campaign.clients[0];
		const res = await apiCall(
			baseUrl,
			`/api/campaigns/${campaign.campaignId}/sessions/${campaign.sessionId}/commands`,
			{
				method: 'POST',
				jar: gm.jar,
				body: {
					commandId: randomUUID(),
					observedSessionVersion: gm.version,
					expectedStructuralVersion: gm.version,
					command: { type: 'end-round' }
				}
			}
		);
		stats.recordCommand(res);

		if (res.ok && res.status === 200 && res.json?.outcome?.ok) {
			const acceptedAt = Date.now();
			const projectionEnvelope = res.json.projection;
			gm.version = projectionEnvelope.sessionVersion;
			gm.cursor = projectionEnvelope.campaignCursor;
			campaign.pendingEvents.push({
				targetCursor: projectionEnvelope.campaignCursor,
				acceptedAt,
				// Only the OTHER two clients count for cross-client visibility —
				// the GM already knows from its own accepted response.
				remaining: new Set(campaign.clients.slice(1))
			});
		} else {
			console.warn(
				`[load] campaign ${campaign.index}: end-round command was not accepted (status ${res.status}, code ${res.json?.outcome?.code ?? 'n/a'})`
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	console.log(
		`[load] starting: ${opts.campaigns} campaigns x ${opts.clientsPerCampaign} clients, ` +
			`${opts.durationSec}s duration, poll ${opts.pollIntervalMs}ms+${opts.jitterMs}ms jitter, ` +
			`command every ${opts.commandIntervalMs}ms per campaign`
	);

	let serverHandle = null;
	let baseUrl = opts.baseUrl;
	const stats = new Stats();
	let exitCode = 1;
	const stopLagSampler = startEventLoopLagSampler(stats);

	// Review round 1: boot now happens INSIDE this try/finally (previously it
	// sat outside), so that even if something in `bootServer` throws after
	// partially setting up state, the finally block below still runs — belt
	// and braces alongside `bootServer`'s own internal kill-on-failure path.
	try {
		if (!baseUrl) {
			serverHandle = await bootServer(opts.port, opts.bootTimeoutMs);
			baseUrl = serverHandle.baseUrl;
		} else {
			console.log(`[load] using already-running server at ${baseUrl}`);
		}

		console.log(`[load] setting up ${opts.campaigns} campaigns...`);
		const campaigns = await Promise.all(
			Array.from({ length: opts.campaigns }, (_, index) => setupCampaign(baseUrl, index))
		);
		console.log('[load] all campaigns ready; entering load window');

		const totalClients = opts.campaigns * opts.clientsPerCampaign;
		const startOffsets = assignPollStartOffsets(totalClients, opts.pollIntervalMs);

		const endTime = Date.now() + opts.durationSec * 1000;
		const tasks = [];
		let clientIndex = 0;
		for (const campaign of campaigns) {
			for (const client of campaign.clients) {
				tasks.push(pollLoop(baseUrl, campaign, client, stats, endTime, opts, startOffsets[clientIndex]));
				clientIndex += 1;
			}
			tasks.push(commandLoop(baseUrl, campaign, stats, endTime, opts));
		}

		await Promise.all(tasks);
		console.log('[load] load window complete');

		exitCode = report(stats, opts);
	} finally {
		stopLagSampler();
		if (serverHandle) {
			console.log('[load] tearing down preview server');
			await serverHandle.cleanup();
		}
	}

	process.exitCode = exitCode;
}

/** For every visibility observation over `thresholdMs`, finds the worst
 * event-loop-lag sample in the `windowMs` immediately preceding it. A
 * correlated (high-lag) outlier is evidence for a harness stall; a clean
 * (low-lag) outlier at the same moment is evidence the harness kept up and
 * the delay is real (server/network/product). Nothing here modifies any
 * measured value — it only reports what else was happening at that instant. */
function correlateOutliers(stats, thresholdMs, windowMs = 3000) {
	return stats.visibilityObservations
		.filter((obs) => obs.latencyMs > thresholdMs)
		.map((obs) => {
			const windowStart = obs.ts - windowMs;
			const samplesInWindow = stats.loopLagSamples.filter((s) => s.ts >= windowStart && s.ts <= obs.ts);
			const maxLagInWindow = samplesInWindow.reduce((max, s) => Math.max(max, s.driftMs), 0);
			return { ...obs, maxLagInWindowMs: maxLagInWindow, lagSamplesInWindow: samplesInWindow.length };
		});
}

function report(stats, opts) {
	const pollLatency = summarizeLatencies(stats.pollLatencies);
	const commandLatency = summarizeLatencies(stats.commandLatencies);
	const visibility = summarizeLatencies(stats.visibilityLatencies);
	const loopLag = summarizeLatencies(stats.loopLagSamples.map((s) => s.driftMs));
	const totalRequests = stats.pollTotal + stats.commandTotal;
	const totalErrors = stats.pollErrors + stats.commandErrors;
	const errorRate = totalRequests > 0 ? totalErrors / totalRequests : 0;
	const poll204Rate = stats.pollTotal > 0 ? stats.poll204 / stats.pollTotal : 0;

	// HTTP-observable proxy for D1 read/write activity — see file header.
	const estimatedReads = stats.poll200 + stats.poll204 + stats.commandTotal;
	const estimatedWrites = stats.commandAccepted;

	const maxVisibilityMs = visibility.max ?? 0;
	// Review round 1: the previous `visibility.count === 0 || maxVisibilityMs
	// <= 2000` short-circuit reported PASS if zero commands were ever
	// accepted (e.g. every command request errored, or a config mistake
	// meant the GM never had permission) — a gate that measured nothing
	// should never silently pass. Both an accepted command AND at least one
	// resulting visibility observation are required for a genuine PASS.
	const measuredAnything = stats.commandAccepted > 0 && visibility.count > 0;
	const visibilityOk = measuredAnything && maxVisibilityMs <= 2000;
	const errorRateOk = errorRate <= 0.001;

	console.log('');
	console.log('=== Load gate summary ===');
	console.log(`campaigns: ${opts.campaigns}, clients/campaign: ${opts.clientsPerCampaign}, duration: ${opts.durationSec}s`);
	console.log('');
	console.log('-- Poll traffic (/sync) --');
	console.log(`  total requests: ${stats.pollTotal}`);
	console.log(`  200 (changed):  ${stats.poll200}`);
	console.log(`  204 (no-op):    ${stats.poll204}  (${(poll204Rate * 100).toFixed(2)}%)`);
	console.log(`  errors:         ${stats.pollErrors}`);
	console.log(
		`  latency ms — p50: ${fmt(pollLatency.p50)}, p95: ${fmt(pollLatency.p95)}, p99: ${fmt(pollLatency.p99)}, max: ${fmt(pollLatency.max)}`
	);
	console.log('');
	console.log('-- Commands (end-round probes) --');
	console.log(`  total: ${stats.commandTotal}, accepted: ${stats.commandAccepted}, errors: ${stats.commandErrors}`);
	console.log(
		`  latency ms — p50: ${fmt(commandLatency.p50)}, p95: ${fmt(commandLatency.p95)}, p99: ${fmt(commandLatency.p99)}, max: ${fmt(commandLatency.max)}`
	);
	console.log('');
	console.log('-- Time-to-visible-event (accepted change -> other client observes it) --');
	console.log(`  observations: ${visibility.count}`);
	console.log(
		`  latency ms — p50: ${fmt(visibility.p50)}, p95: ${fmt(visibility.p95)}, p99: ${fmt(visibility.p99)}, max: ${fmt(visibility.max)}`
	);
	const over1500 = stats.visibilityObservations.filter((o) => o.latencyMs > 1500).length;
	const over2000 = stats.visibilityObservations.filter((o) => o.latencyMs > 2000).length;
	console.log(`  observations > 1500ms: ${over1500}, observations > 2000ms: ${over2000}`);
	console.log('');
	console.log('-- Harness event-loop lag (diagnostic — see file header Self-measurement note) --');
	console.log(`  samples: ${loopLag.count}`);
	console.log(
		`  drift ms — p50: ${fmt(loopLag.p50)}, p95: ${fmt(loopLag.p95)}, p99: ${fmt(loopLag.p99)}, max: ${fmt(loopLag.max)}`
	);
	if (over2000 > 0) {
		console.log('');
		console.log('-- Correlation: event-loop lag in the 3s before each >2000ms visibility outlier --');
		for (const o of correlateOutliers(stats, 2000)) {
			console.log(
				`  ts=${new Date(o.ts).toISOString()} campaign=${o.campaignIndex} role=${o.role} latencyMs=${o.latencyMs.toFixed(1)} ` +
					`maxLoopLagInPrior3sMs=${o.maxLagInWindowMs.toFixed(1)} lagSamplesInWindow=${o.lagSamplesInWindow}`
			);
		}
	}
	console.log('');
	console.log('-- HTTP-observable D1 read/write proxy (not literal D1 instrumentation) --');
	console.log(`  estimated reads:  ${estimatedReads}`);
	console.log(`  estimated writes: ${estimatedWrites}`);
	console.log('');
	console.log(`overall requests: ${totalRequests}, overall errors: ${totalErrors}, error rate: ${(errorRate * 100).toFixed(4)}%`);
	console.log('');
	if (!measuredAnything) {
		console.log(
			`Gate: max visible-change latency <= 2000ms? FAIL (measured nothing — ${stats.commandAccepted} commands accepted, ${visibility.count} visibility observations; a gate that observed no accepted change cannot certify the visibility budget)`
		);
	} else {
		console.log(`Gate: max visible-change latency <= 2000ms? ${visibilityOk ? 'PASS' : 'FAIL'} (max observed ${fmt(maxVisibilityMs)}ms)`);
	}
	console.log(`Gate: error rate <= 0.1%? ${errorRateOk ? 'PASS' : 'FAIL'} (observed ${(errorRate * 100).toFixed(4)}%)`);
	console.log('');

	if (!visibilityOk || !errorRateOk) {
		console.error('[load] FAILED — see gate results above');
		return 1;
	}
	console.log('[load] PASSED');
	return 0;
}

function fmt(value) {
	return value === null || value === undefined ? 'n/a' : value.toFixed(1);
}

main().catch((err) => {
	console.error('[load] fatal error:', err);
	process.exitCode = 1;
});
