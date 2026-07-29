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
 * D1 read/write counts: the "reads"/"writes" reported below are an
 * HTTP-observable proxy — every 200/204 sync response is one read, and every
 * command *attempt* (accepted or rejected) is also counted as one read,
 * since `executeCommand` always loads current session state to evaluate a
 * command before it can decide to accept or reject it; every *accepted*
 * command additionally counts as one write — documented as such in the
 * completion record, never presented as measured D1 metrics. They are kept
 * because the consumption projection in `docs/operations/campaign-capacity.md`
 * is defined against them and redefining them mid-stream would make runs
 * incomparable.
 *
 * Server-side timing (added 2026-07-28, after BOTH 30-minute gate runs failed):
 * the two failing runs measured only client-observed wall clock and so could
 * not say whether the latency was the network or D1 — the deployed Worker had
 * no self-measurement at all. The application now emits `Server-Timing:
 * srv;dur=…, d1;dur=…;desc="n=… stmts=…"` whenever `CAMPAIGN_TIMING_HEADER` is
 * set (staging sets it; production deliberately does not), and this harness
 * records it per request. That makes `latencyMs - srv` the wire and `srv - d1`
 * the Worker's own work, so the question is answered by subtraction. Coverage
 * is reported explicitly: a run whose header never arrived must look different
 * from a run whose server genuinely took no time. See
 * `src/lib/server/observability/request-timing.ts`, including why `Date.now()`
 * inside a Worker measures I/O wall time and not CPU.
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
		bootTimeoutMs: 90_000,
		// Committed in docs/operations/campaign-capacity.md before the gate run.
		pollP95BudgetMs: 1200,
		commandP95BudgetMs: 2000
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
		// Staging sets this in `[env.staging.vars]`; a local preview run has to
		// set it explicitly or the server/wire split below reports 0% coverage
		// and the local run cannot exercise the instrumentation it is meant to
		// rehearse. See src/lib/server/observability/request-timing.ts.
		CAMPAIGN_TIMING_HEADER: 'true',
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
	const timing = parseServerTiming(res.headers.get('server-timing'));
	const colo = res.headers.get('x-guildbook-colo');
	let json = null;
	if (res.status !== 204) {
		try {
			json = await res.json();
		} catch {
			// non-JSON body; leave json null
		}
	}
	return { ok: res.ok, status: res.status, latencyMs, json, error: null, timing, colo };
}

/**
 * Parses the `Server-Timing` header the application emits when
 * `CAMPAIGN_TIMING_HEADER` is set — `srv;dur=42.5, d1;dur=31;desc="n=6 stmts=9"`
 * (see src/lib/server/observability/request-timing.ts).
 *
 * This is the whole point of the 2026-07-28 follow-up: with `serverMs` in hand,
 * `latencyMs - serverMs` is the wire, and both 30-minute gate runs' unanswerable
 * question ("network or D1?") becomes a subtraction instead of an argument.
 *
 * Returns `null` when the header is absent or unparseable, and the caller
 * reports that as missing coverage — never as a zero. A silent zero would read
 * as "the server took no time", which is the single most misleading thing this
 * harness could say.
 */
function parseServerTiming(header) {
	if (!header) return null;
	const srv = /(?:^|,)\s*srv;dur=([0-9.]+)/.exec(header);
	if (!srv) return null;

	const d1 = /(?:^|,)\s*d1;dur=([0-9.]+)/.exec(header);
	const counts = /d1;dur=[0-9.]+;desc="n=(\d+) stmts=(\d+) sum=([0-9.]+)"/.exec(header);
	return {
		serverMs: Number(srv[1]),
		// A request answered from the isolate-local cursor hint touches no
		// database at all, and the server omits the `d1` metric entirely rather
		// than claiming `dur=0`. Zero is the right value for the arithmetic here;
		// what matters is that it came from a real absence, not a parse failure.
		//
		// `dur` is the UNION of the call intervals — the only D1 figure that may
		// be subtracted from server time. `sum` is the total of the individual
		// call durations, which double-counts a route's concurrent queries and is
		// therefore the right numerator for average per-round-trip latency but
		// the wrong one for a decomposition. See request-timing.ts.
		d1WallMs: d1 ? Number(d1[1]) : 0,
		d1SumMs: counts ? Number(counts[3]) : 0,
		d1Calls: counts ? Number(counts[1]) : 0,
		d1Statements: counts ? Number(counts[2]) : 0
	};
}

// ---------------------------------------------------------------------------
// Staging mode (Increment 5 Task 4 Step 1)
//
// Against a local preview server this harness authenticates through the dev
// Credentials provider. Staging has no dev login — deliberately, so a public
// URL never carries an impersonation bypass — so in staging mode it seeds
// fixture users straight into staging D1 and signs its own Auth.js session
// JWTs, exactly as `scripts/campaigns/staging-d1-smoke.mjs` does.
//
// Users are seeded in ONE batched statement rather than one call per user:
// 27 separate `wrangler d1 execute` round trips would add ~40s to setup and
// would itself distort the very latency numbers this harness exists to measure.
// ---------------------------------------------------------------------------

const AUTH_SESSION_VERSION = 2; // must match src/lib/server/auth-policy.ts
const STAGING_COOKIE_NAME = '__Secure-authjs.session-token';

const stagingMode = (process.env.CAMPAIGN_LOAD_TARGET ?? '').toLowerCase() === 'staging';
const stagingAuthSecret = process.env.CAMPAIGN_STAGING_AUTH_SECRET ?? '';
const stagingD1Name = process.env.CAMPAIGN_STAGING_D1_NAME ?? 'guild-book-staging-db';
const stagingWranglerEnv = process.env.CAMPAIGN_STAGING_WRANGLER_ENV ?? 'staging';
const stagingUserPool = [];

// When set, the harness reuses an already-seeded pool of fixture users instead
// of creating new ones. This is what lets CI run without any Cloudflare
// credentials: seeding needs D1 write access, but minting a session cookie for
// an existing user needs only AUTH_SECRET. Seed the pool once with
// `scripts/campaigns/seed-load-fixtures.mjs`.
const stagingUserPrefix = process.env.CAMPAIGN_STAGING_USER_PREFIX ?? '';

async function seedStagingUsers(count) {
	if (stagingUserPrefix) {
		const ids = Array.from({ length: count }, (_, i) => `${stagingUserPrefix}-${i}`);
		stagingUserPool.push(...ids);
		console.log(`[load] reusing ${ids.length} pre-seeded fixture users (${stagingUserPrefix}-0..${count - 1})`);
		return;
	}

	const ids = Array.from({ length: count }, (_, i) => `load-${RUN_ID}-${i}`);
	const values = ids.map((id) => `('${id}','${id}')`).join(',');
	const { execFile } = await import('node:child_process');
	const { promisify } = await import('node:util');
	await promisify(execFile)(
		'npx',
		[
			'wrangler',
			'd1',
			'execute',
			stagingD1Name,
			'--remote',
			'--env',
			stagingWranglerEnv,
			'--command',
			`INSERT INTO users (id, name) VALUES ${values}`
		],
		{ maxBuffer: 1024 * 1024 * 32 }
	);
	stagingUserPool.push(...ids);
	console.log(`[load] seeded ${ids.length} staging fixture users in one batch`);
}

async function mintStagingCookie(userId) {
	const { encode } = await import('@auth/core/jwt');
	return encode({
		token: { sub: userId, sessionVersion: AUTH_SESSION_VERSION },
		secret: stagingAuthSecret,
		salt: STAGING_COOKIE_NAME,
		maxAge: 60 * 60 * 6
	});
}

async function login(baseUrl, jar, email, name) {
	if (stagingMode) {
		const userId = stagingUserPool.shift();
		if (!userId) throw new Error('staging fixture user pool exhausted — seedStagingUsers undercounted');
		jar.set(STAGING_COOKIE_NAME, await mintStagingCookie(userId));
		return;
	}

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

/**
 * Accumulates the server/wire decomposition for one request class.
 *
 * Added after both 2026-07-28 gate runs failed with no way to attribute the
 * latency. The client already measures `latencyMs` end to end; the server now
 * reports how much of that it spent, and how much of ITS time went to D1 round
 * trips. Subtracting gives three terms that add up:
 *
 *     latencyMs  =  wireMs  +  serverMs
 *     serverMs   =  d1Ms    +  (worker CPU and non-D1 awaits)
 *
 * `missingHeader` is tracked separately and reported, because a run where the
 * header never arrived must look obviously different from a run where the
 * server genuinely took no time.
 */
class TimingSplit {
	records = [];
	total = 0;
	missingHeader = 0;

	record(res) {
		this.total += 1;
		if (!res.timing) {
			this.missingHeader += 1;
			return;
		}
		const { serverMs, d1WallMs, d1SumMs, d1Calls, d1Statements } = res.timing;
		this.records.push({
			latencyMs: res.latencyMs,
			serverMs,
			d1WallMs,
			d1SumMs,
			// Clamped, not signed. The two sides use different clocks, and the
			// Workers runtime advances `Date.now()` only on I/O, so a very fast
			// response can report a server time a millisecond or two above the
			// client's total. A negative "wire time" would be an artifact of that
			// skew, not a measurement.
			wireMs: Math.max(0, res.latencyMs - serverMs),
			// Against the UNION, not the sum. Subtracting the sum here is what made
			// the 2026-07-28 smoke run report a poll D1 p50 above its server p50 —
			// impossible for any one request, and the tell that overlap was being
			// counted twice.
			workerOtherMs: Math.max(0, serverMs - d1WallMs),
			d1Calls,
			d1Statements
		});
	}

	get covered() {
		return this.records.length;
	}

	column(key) {
		return this.records.map((r) => r[key]);
	}

	/** Means, because only means decompose additively — the p50 of the wire and
	 * the p50 of the server time belong to different requests and do not sum to
	 * the p50 of the total. Percentiles are reported separately, per column. */
	means() {
		if (this.records.length === 0) return null;
		const sum = (key) => this.records.reduce((acc, r) => acc + r[key], 0);
		const n = this.records.length;
		return {
			latencyMs: sum('latencyMs') / n,
			wireMs: sum('wireMs') / n,
			serverMs: sum('serverMs') / n,
			d1WallMs: sum('d1WallMs') / n,
			d1SumMs: sum('d1SumMs') / n,
			workerOtherMs: sum('workerOtherMs') / n,
			d1Calls: sum('d1Calls') / n,
			d1Statements: sum('d1Statements') / n
		};
	}
}

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

	// Server/wire decomposition, per request class. See TimingSplit above.
	pollTiming = new TimingSplit();
	commandTiming = new TimingSplit();
	// Which Cloudflare colo served each request. The 00:26 and 03:00 runs turned
	// on a geography question neither could answer from the client side; this
	// records the answer instead of inferring it from where the harness ran.
	colos = new Map();

	noteColo(colo) {
		if (!colo) return;
		this.colos.set(colo, (this.colos.get(colo) ?? 0) + 1);
	}

	recordPoll(res) {
		this.pollTotal += 1;
		this.noteColo(res.colo);
		if (res.status === 200) {
			this.poll200 += 1;
			this.pollLatencies.push(res.latencyMs);
			this.pollTiming.record(res);
		} else if (res.status === 204) {
			this.poll204 += 1;
			this.pollLatencies.push(res.latencyMs);
			this.pollTiming.record(res);
		} else {
			this.pollErrors += 1;
		}
	}

	// (sessionId, resultingVersion) pairs already claimed by an accepted
	// command. Two accepted commands reporting the same resulting version means
	// the version claim is not exclusive — a lost write, not a slow one.
	claimedVersions = new Set();
	duplicateResultingVersions = 0;
	// Accepted commands whose change no client ever observed. Keyed to the
	// acceptance timestamp so the tail of the run can be excluded — see
	// `countLostCommands`.
	acceptedCommandKeys = new Map();
	observedCommandKeys = new Set();
	windowEndedAt = null;

	/**
	 * A command is only "lost" if the run gave every other client a fair chance
	 * to see it and none did. Commands accepted in the final moments of the load
	 * window are unobserved because the window closed, not because anything was
	 * dropped — counting those would make this gate fail every run.
	 *
	 * The grace period is one full poll cycle plus the WORST propagation this
	 * run actually demonstrated: if a change had longer than the slowest
	 * observed propagation and still reached nobody, it is genuinely lost.
	 *
	 * An earlier version used a fixed 2000ms (the budget) instead of the
	 * observed maximum. That is unsound whenever a run's tail exceeds the
	 * budget — the 2026-07-28 gate run peaked at 6853ms, so a command accepted
	 * ~4s before the window closed could still be propagating normally and be
	 * miscounted as lost. This is a fix to the measurement, NOT a relaxation of
	 * the gate: the threshold is still zero lost commands.
	 */
	countLostCommands(graceMs) {
		const cutoff = (this.windowEndedAt ?? Date.now()) - graceMs;
		let lost = 0;
		for (const [key, acceptedAt] of this.acceptedCommandKeys) {
			if (acceptedAt <= cutoff && !this.observedCommandKeys.has(key)) lost += 1;
		}
		return lost;
	}

	recordCommand(res, sessionId) {
		this.commandTotal += 1;
		this.commandLatencies.push(res.latencyMs);
		this.commandTiming.record(res);
		this.noteColo(res.colo);
		if (res.ok && res.status === 200 && res.json?.outcome?.ok) {
			this.commandAccepted += 1;
			const version = res.json.outcome.resultingVersion;
			if (sessionId !== undefined && version !== undefined) {
				const key = `${sessionId}#${version}`;
				if (this.claimedVersions.has(key)) this.duplicateResultingVersions += 1;
				else this.claimedVersions.add(key);
				this.acceptedCommandKeys.set(key, Date.now());
			}
		} else this.commandErrors += 1;
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
			if (event.commandKey) stats.observedCommandKeys.add(event.commandKey);
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
		stats.recordCommand(res, campaign.sessionId);

		if (res.ok && res.status === 200 && res.json?.outcome?.ok) {
			const acceptedAt = Date.now();
			const projectionEnvelope = res.json.projection;
			gm.version = projectionEnvelope.sessionVersion;
			gm.cursor = projectionEnvelope.campaignCursor;
			campaign.pendingEvents.push({
				// Carried so a visibility observation can mark THIS accepted
				// command as seen — that is what distinguishes a slow change
				// from a lost one.
				commandKey: `${campaign.sessionId}#${res.json.outcome.resultingVersion}`,
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
		if (stagingMode) {
			if (!baseUrl) throw new Error('CAMPAIGN_LOAD_TARGET=staging requires --base-url');
			if (!stagingAuthSecret) throw new Error('CAMPAIGN_LOAD_TARGET=staging requires CAMPAIGN_STAGING_AUTH_SECRET');
			if (/guildbook\.arrowed\.games/.test(baseUrl)) {
				throw new Error('refusing to load-test the production hostname');
			}
			console.log(`[load] STAGING mode against ${baseUrl}`);
			await seedStagingUsers(opts.campaigns * opts.clientsPerCampaign);
		} else if (!baseUrl) {
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
		stats.windowEndedAt = Date.now();
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

	// Increment 5 Task 4 Step 2 — the p95 budgets committed in
	// docs/operations/campaign-capacity.md BEFORE the gate run. Deliberately
	// NOT exposed as CLI flags: a threshold that can be raised from the command
	// line when a run goes red is not a gate. Changing these means editing the
	// defaults here AND recording a dated amendment in that document.
	const pollP95Ok = pollLatency.p95 === null || pollLatency.p95 <= opts.pollP95BudgetMs;
	const commandP95Ok = commandLatency.p95 === null || commandLatency.p95 <= opts.commandP95BudgetMs;
	// A "no lost or duplicated accepted command" check: every accepted command
	// must claim a distinct resulting version, and none may vanish.
	// One poll cycle plus the worst propagation this run demonstrated — never
	// less than the 2000ms budget, so a fast run cannot shrink the window.
	const lostGraceMs =
		opts.pollIntervalMs + opts.jitterMs + Math.max(2000, visibility.max ?? 0);
	const lostCommands = stats.countLostCommands(lostGraceMs);
	const commandIntegrityOk = stats.duplicateResultingVersions === 0 && lostCommands === 0;

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
	console.log('-- Server-side vs wire split (Server-Timing; see docs/operations/campaign-capacity.md) --');
	const measuredTrips =
		stats.pollTiming.records.reduce((acc, r) => acc + r.d1Calls, 0) +
		stats.commandTiming.records.reduce((acc, r) => acc + r.d1Calls, 0);
	printTimingSplit('poll   ', stats.pollTiming);
	printTimingSplit('command', stats.commandTiming);
	// A local preview run is backed by better-sqlite3, which is deliberately NOT
	// instrumented: its queries are synchronous in-process calls, not network
	// round trips, and counting them here would invite a local run's numbers to
	// be compared against a staging run's as though they measured the same
	// thing. Say so out loud rather than leave a row of zeroes to be misread.
	const anyCoverage = stats.pollTiming.covered + stats.commandTiming.covered > 0;
	if (anyCoverage && measuredTrips === 0) {
		console.log(
			'  NOTE: zero D1 round trips observed. This target is not backed by a D1 binding'
		);
		console.log(
			'        (a local better-sqlite3 preview is not instrumented — only D1 is), so the'
		);
		console.log(
			'        D1 rows above are structurally zero and the worker/other column absorbs all'
		);
		console.log(
			'        database time. Only a staging run answers the question this split exists for.'
		);
	}
	if (stats.colos.size > 0) {
		const served = [...stats.colos.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([colo, count]) => `${colo}=${count}`)
			.join(', ');
		console.log(`  Cloudflare colo(s) serving this run: ${served}`);
	} else {
		console.log('  Cloudflare colo: not reported (off-edge target, or CAMPAIGN_TIMING_HEADER unset)');
	}

	console.log('');
	console.log('-- HTTP-observable D1 read/write proxy (not literal D1 instrumentation) --');
	console.log(`  estimated reads:  ${estimatedReads}`);
	console.log(`  estimated writes: ${estimatedWrites}`);
	// Superseded, but kept: this proxy is what the consumption projection in
	// campaign-capacity.md was to be derived from, and changing its definition
	// mid-stream would make runs incomparable. The split above now reports the
	// real per-request round-trip count, which is the better source — say which
	// one any published figure came from.
	if (measuredTrips > 0) {
		console.log(`  (measured D1 round trips across covered requests: ${measuredTrips})`);
	}
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
	console.log(
		`Gate: poll p95 <= ${opts.pollP95BudgetMs}ms? ${pollP95Ok ? 'PASS' : 'FAIL'} (observed ${fmt(pollLatency.p95)}ms)`
	);
	console.log(
		`Gate: command p95 <= ${opts.commandP95BudgetMs}ms? ${commandP95Ok ? 'PASS' : 'FAIL'} (observed ${fmt(commandLatency.p95)}ms)`
	);
	console.log(
		`Gate: no lost or duplicated accepted command? ${commandIntegrityOk ? 'PASS' : 'FAIL'} ` +
			`(${stats.duplicateResultingVersions} duplicate resulting versions, ${lostCommands} lost; ` +
			`commands accepted within ${lostGraceMs}ms of the window close are excluded — the run ended, nothing was dropped)`
	);
	console.log('');

	if (!visibilityOk || !errorRateOk || !pollP95Ok || !commandP95Ok || !commandIntegrityOk) {
		console.error('[load] FAILED — see gate results above');
		return 1;
	}
	console.log('[load] PASSED');
	return 0;
}

/**
 * Prints one request class's server/wire decomposition.
 *
 * The line that matters most is the last one: milliseconds per D1 round trip.
 * A Worker co-located with the D1 primary pays single-digit milliseconds a hop;
 * one a continent away pays tens. Together with the round-trip count that is
 * the direct test of the hypothesis recorded in campaign-capacity.md, and it
 * replaces two runs' worth of arguing from correlated bursts.
 */
function printTimingSplit(label, split) {
	const coverage = split.total > 0 ? split.covered / split.total : 0;
	console.log(
		`  ${label} responses carrying timing: ${split.covered}/${split.total} (${(coverage * 100).toFixed(1)}%)`
	);
	if (split.covered === 0) {
		console.log(`  ${label} no Server-Timing observed — the split cannot be computed for this class.`);
		console.log(
			`  ${label} (staging sets CAMPAIGN_TIMING_HEADER in [env.staging.vars]; if this run targeted staging, the deploy is stale)`
		);
		return;
	}

	const server = summarizeLatencies(split.column('serverMs'));
	const wire = summarizeLatencies(split.column('wireMs'));
	const d1Wall = summarizeLatencies(split.column('d1WallMs'));
	const calls = summarizeLatencies(split.column('d1Calls'));
	console.log(
		`  ${label} server ms  — p50: ${fmt(server.p50)}, p95: ${fmt(server.p95)}, p99: ${fmt(server.p99)}, max: ${fmt(server.max)}`
	);
	console.log(
		`  ${label} wire ms    — p50: ${fmt(wire.p50)}, p95: ${fmt(wire.p95)}, p99: ${fmt(wire.p99)}, max: ${fmt(wire.max)}`
	);
	console.log(
		`  ${label} D1 wall ms — p50: ${fmt(d1Wall.p50)}, p95: ${fmt(d1Wall.p95)}, p99: ${fmt(d1Wall.p99)}, max: ${fmt(d1Wall.max)}`
	);
	console.log(
		`  ${label} D1 round trips — p50: ${fmt(calls.p50)}, p95: ${fmt(calls.p95)}, max: ${fmt(calls.max)}`
	);

	const means = split.means();
	// Means, not percentiles, because only means decompose additively — see
	// TimingSplit.means(). These three terms sum to the mean request, and the D1
	// term is the union of the call intervals, so overlap is not counted twice.
	console.log(
		`  ${label} mean ${fmt(means.latencyMs)}ms = ${fmt(means.wireMs)}ms wire + ${fmt(means.d1WallMs)}ms D1 + ${fmt(means.workerOtherMs)}ms worker/other`
	);
	// Per-round-trip uses the SUM, which is the total time actually spent in
	// calls. This is the figure that exposes Worker-to-primary distance, and it
	// is unaffected by whether the route ran its queries in parallel.
	const perTrip = means.d1Calls > 0 ? means.d1SumMs / means.d1Calls : null;
	console.log(
		`  ${label} mean ${means.d1Calls.toFixed(2)} D1 round trips carrying ${means.d1Statements.toFixed(2)} statements` +
			(perTrip === null ? ' (no D1 traffic)' : ` — ${perTrip.toFixed(1)}ms per round trip`)
	);
	if (means.d1WallMs > 0) {
		// How much of the D1 work the route actually overlapped. 1.0 = fully
		// sequential, so every round trip is on the critical path; 2.0 = on
		// average two calls in flight at once. This is the direct read on whether
		// the round-trip count can be hidden by parallelism or has to be reduced.
		console.log(
			`  ${label} D1 call-time sum ${fmt(means.d1SumMs)}ms vs ${fmt(means.d1WallMs)}ms wall — ${(means.d1SumMs / means.d1WallMs).toFixed(2)}x average concurrency`
		);
	}
}

function fmt(value) {
	return value === null || value === undefined ? 'n/a' : value.toFixed(1);
}

main().catch((err) => {
	console.error('[load] fatal error:', err);
	process.exitCode = 1;
});
