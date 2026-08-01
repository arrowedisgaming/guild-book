#!/usr/bin/env node
/**
 * Increment 5 Task 5 Step 2 — configuration-rollback rehearsal against STAGING.
 *
 * The plan requires rehearsing the rollback that `campaign-rollback.md` tells an
 * operator to perform during an incident, and recording the propagation time it
 * actually takes. This script is that rehearsal, automated so the runbook's
 * numbers are reproducible rather than remembered.
 *
 * It drives five phases, in the plan's order:
 *
 *   1. Start a real active staging session and record safe aggregate health.
 *   2. Deploy CAMPAIGNS_ENABLED=false with an empty pilot allowlist.
 *   3. Verify campaign/join/API routes 404 while character, rules, denizen,
 *      deck, login and sharing paths still work.
 *   4. Restore ONLY operator pilot access, recover/end the session, verify
 *      public history.
 *   5. Re-enable staging and verify no data migration rollback was required.
 *
 * WHY IT DEPLOYS ITSELF
 * The number the runbook needs is "how long from the flip until the feature is
 * actually gone", and that interval starts when `wrangler deploy` returns. A
 * human running the deploy in one window and a probe in another cannot measure
 * it to better than a shrug. The script builds ONCE and then redeploys the same
 * artifact with different `--var` values, so the only thing changing between
 * measurements is the flag — which is exactly the experiment.
 *
 * SAFETY
 * - Refuses to run without an explicit base URL, auth secret and health secret.
 * - Refuses to run against the production hostname, and refuses any wrangler
 *   environment whose name does not contain "staging".
 * - Restores the flag on ANY exit path, including Ctrl-C and an unhandled
 *   throw, and prints the manual restore command if even that fails.
 * - Creates only prefixed fixture rows, archives its own campaign, and never
 *   deletes arbitrary rows.
 * - Prints no invite token, share token, session secret, cookie or card
 *   identity. Campaign/session ids ARE printed: they are fixture ids, and the
 *   runbook's "identify affected sessions" step needs to show what that looks
 *   like. They must not be copied into the committed runbook.
 *
 * USAGE
 *   CAMPAIGN_STAGING_AUTH_SECRET=<staging AUTH_SECRET> \
 *   CAMPAIGN_HEALTH_SECRET=<staging CAMPAIGN_HEALTH_SECRET> \
 *   node scripts/campaigns/rollback-rehearsal.mjs
 *
 * Optional:
 *   CAMPAIGN_STAGING_BASE_URL   (default https://guild-book-staging.esoneill.workers.dev)
 *   CAMPAIGN_STAGING_WRANGLER_ENV (default staging)
 *   --skip-build                reuse an existing .svelte-kit/cloudflare build
 *   --report <path>             write the sanitized JSON report here
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { encode } from '@auth/core/jwt';

const execFileAsync = promisify(execFile);

// Must match AUTH_SESSION_VERSION in src/lib/server/auth-policy.ts.
const AUTH_SESSION_VERSION = 2;
const COOKIE_NAME = '__Secure-authjs.session-token';

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(`--${name}`);
const flagValue = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};

const BASE_URL = (
	process.env.CAMPAIGN_STAGING_BASE_URL ?? 'https://guild-book-staging.esoneill.workers.dev'
).replace(/\/$/, '');
const AUTH_SECRET = process.env.CAMPAIGN_STAGING_AUTH_SECRET ?? '';
const HEALTH_SECRET = process.env.CAMPAIGN_HEALTH_SECRET ?? '';
const WRANGLER_ENV = process.env.CAMPAIGN_STAGING_WRANGLER_ENV ?? 'staging';
const SKIP_BUILD = hasFlag('skip-build');
const REPORT_PATH = flagValue('report', null);

const PREFIX = `rollback-${Date.now().toString(36)}`;

// ---------------------------------------------------------------------------
// Guards — every one of these has a way of mattering exactly once
// ---------------------------------------------------------------------------

if (!AUTH_SECRET) fail('CAMPAIGN_STAGING_AUTH_SECRET is required (staging AUTH_SECRET; signs fixture session cookies).');
if (!HEALTH_SECRET) fail('CAMPAIGN_HEALTH_SECRET is required (staging value; the health endpoint 404s to everyone without it).');
if (!/^https:\/\//.test(BASE_URL)) fail(`Refusing to run against a non-HTTPS URL: ${BASE_URL}`);
if (/guildbook\.arrowed\.games/.test(BASE_URL)) {
	fail('Refusing to run against the production hostname. This script DISABLES CAMPAIGNS and redeploys.');
}
if (!WRANGLER_ENV.includes('staging')) {
	fail(`Refusing to deploy to wrangler environment "${WRANGLER_ENV}" — this script only drives staging.`);
}

function fail(message) {
	console.error(`\n✘ ${message}\n`);
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const report = { baseUrl: BASE_URL, wranglerEnv: WRANGLER_ENV, fixturePrefix: PREFIX, phases: [] };
const failures = [];
let currentPhase = null;

function phase(title) {
	currentPhase = { title, checks: [], notes: [] };
	report.phases.push(currentPhase);
	console.log(`\n=== ${title} ===`);
}

function note(message) {
	currentPhase?.notes.push(message);
	console.log(`   · ${message}`);
}

function check(ok, description, detail) {
	currentPhase?.checks.push({ ok, description, detail: detail ?? null });
	console.log(`   ${ok ? '✓' : '✘'} ${description}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures.push(`${currentPhase?.title}: ${description}${detail ? ` — ${detail}` : ''}`);
	return ok;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function newActor(userId, label) {
	return { userId, label, cookie: null };
}

async function signIn(actor) {
	actor.cookie = await encode({
		token: { sub: actor.userId, sessionVersion: AUTH_SESSION_VERSION },
		secret: AUTH_SECRET,
		salt: COOKIE_NAME,
		maxAge: 60 * 60 * 6
	});
}

/** Never throws: a status is data here, including 0 for a transport failure. */
async function request(path, { method = 'GET', actor = null, body, bearer = null } = {}) {
	const headers = { Origin: BASE_URL };
	if (actor?.cookie) headers.Cookie = `${COOKIE_NAME}=${actor.cookie}`;
	if (bearer) headers.Authorization = `Bearer ${bearer}`;
	if (body !== undefined) headers['Content-Type'] = 'application/json';
	try {
		const res = await fetch(`${BASE_URL}${path}`, {
			method,
			headers,
			redirect: 'manual',
			body: body !== undefined ? JSON.stringify(body) : undefined
		});
		let json = null;
		if (res.status !== 204) {
			try {
				json = await res.json();
			} catch {
				// HTML page or empty body; the status is what these checks read.
			}
		}
		return { status: res.status, json, serverTiming: res.headers.get('server-timing') };
	} catch (err) {
		return { status: 0, json: null, serverTiming: null, error: String(err?.message ?? err) };
	}
}

async function health() {
	const res = await request('/api/internal/campaign-health', { bearer: HEALTH_SECRET });
	return res;
}

// ---------------------------------------------------------------------------
// Deployment
// ---------------------------------------------------------------------------

/**
 * Staging's vars, passed explicitly on every override deploy.
 *
 * `wrangler deploy` without `--keep-vars` deletes all vars before applying the
 * ones it knows about, and `--var` is an override layer on top of the config
 * block. Listing every var on each override deploy means the deploy does not
 * depend on which of those two behaviours is true this Wrangler version — and
 * `CAMPAIGN_TIMING_HEADER` surviving is asserted afterwards via `Server-Timing`,
 * so a silent var wipe cannot pass unnoticed.
 */
function varArgs({ campaignsEnabled, pilotUserIds }) {
	const vars = [
		`CAMPAIGNS_ENABLED:${campaignsEnabled}`,
		'CAMPAIGN_TIMING_HEADER:true'
	];
	// An absent allowlist and an empty one are the same thing to
	// `getCampaignFeatureConfig`, but passing it explicitly documents the intent
	// in the deploy's own record.
	vars.push(`CAMPAIGNS_PILOT_USER_IDS:${pilotUserIds ?? ''}`);
	return vars.flatMap((v) => ['--var', v]);
}

let restoreNeeded = false;

async function deploy(label, overrides) {
	const argv = ['wrangler', 'deploy', '--env', WRANGLER_ENV];
	if (overrides) argv.push(...varArgs(overrides));
	console.log(`   → deploying: ${label}`);
	const startedAt = Date.now();
	let stdout = '';
	try {
		({ stdout } = await execFileAsync('npx', argv, { maxBuffer: 1024 * 1024 * 32 }));
	} catch (err) {
		console.error(err.stdout ?? '');
		console.error(err.stderr ?? '');
		throw new Error(`wrangler deploy failed for "${label}"`);
	}
	const deployMs = Date.now() - startedAt;
	const version = /Current Version ID:\s*([0-9a-f-]+)/i.exec(stdout)?.[1] ?? null;
	// The clock the propagation measurement starts from: the moment Cloudflare
	// told us the new version is the live one.
	const returnedAt = Date.now();
	console.log(`   → deployed in ${(deployMs / 1000).toFixed(1)}s${version ? ` (version ${version})` : ''}`);
	return { label, deployMs, version, returnedAt };
}

/**
 * Time from a deploy returning until the new behaviour is what every request
 * gets — not until the first request happens to see it.
 *
 * The distinction is the whole point, and the 2026-07-29 run learned it the
 * hard way. A flag flip does NOT land atomically: for a window afterwards, some
 * requests are answered with the new configuration and some with the old. An
 * earlier version of this function returned as soon as ONE probe saw the new
 * behaviour, reported "operator access returned in 380 ms", and the very next
 * request in the rehearsal hit a stale isolate and 404'd — which cascaded into
 * four bogus failures downstream.
 *
 * First-observation is therefore the wrong number to put in a runbook: an
 * operator reading it would declare an incident contained while the feature was
 * still reachable.
 *
 * Two further things the 2026-07-29 investigation established, both of which
 * shape this design:
 *
 *   - **A stale isolate can survive more than one deploy.** During the phase-4
 *     transition a player briefly received `200`, which neither the old config
 *     (off, no allowlist) nor the new one (off, GM allowlisted) permits — only
 *     the fully-enabled config from TWO deploys earlier does. Chaining flag
 *     deploys compounds the window rather than shortening it.
 *   - **Different endpoints disagree with each other.** `/api/internal/campaign-health`
 *     reported `campaignsEnabled: true` for 18 s while the campaign routes were
 *     already enforcing `false`. Health alone cannot confirm a rollback landed.
 *
 * So a single probe of a single actor cannot establish that a flip is complete.
 * `expectations` is a vector of independent observations — each actor that must
 * be allowed, each that must be refused, and the flag as health reports it —
 * evaluated together each round. The flip counts as settled only once EVERY
 * expectation holds simultaneously and keeps holding for `settleMs`.
 *
 *   firstAllOkMs        — first round where the whole vector agreed
 *   lastDisagreementMs  — last round where anything disagreed
 *   settledMs           — the vector had agreed continuously for settleMs
 *   mixedWindowMs       — lastDisagreementMs - firstAllOkMs: how long the edge
 *                         was serving a mix after first looking correct
 *   disagreedOn         — which expectations ever disagreed, for diagnosis
 *
 * `settledMs` is the runbook number. `mixedWindowMs` is the one that decides
 * whether "it's off now" is safe to say out loud.
 */
async function measurePropagation(
	deployResult,
	expectations,
	{ timeoutMs = 300_000, intervalMs = 1000, settleMs = 15_000 } = {}
) {
	const deadline = Date.now() + timeoutMs;
	let attempts = 0;
	let agreeingSince = null;
	let firstAllOkMs = null;
	let lastDisagreementMs = null;
	const disagreed = new Set();

	while (Date.now() < deadline) {
		attempts += 1;
		// Evaluated together so one round is one coherent picture of the edge,
		// not a sequence of observations that could each be from a different
		// version.
		const results = await Promise.all(expectations.map(async (e) => [e.label, await e.holds()]));
		const elapsed = Date.now() - deployResult.returnedAt;
		const failing = results.filter(([, ok]) => !ok).map(([label]) => label);

		if (failing.length === 0) {
			if (firstAllOkMs === null) firstAllOkMs = elapsed;
			if (agreeingSince === null) agreeingSince = Date.now();
			if (Date.now() - agreeingSince >= settleMs) {
				return {
					firstAllOkMs,
					lastDisagreementMs,
					settledMs: elapsed,
					mixedWindowMs: lastDisagreementMs === null ? 0 : Math.max(0, lastDisagreementMs - firstAllOkMs),
					disagreedOn: [...disagreed],
					attempts,
					timedOut: false
				};
			}
		} else {
			lastDisagreementMs = elapsed;
			agreeingSince = null;
			for (const label of failing) disagreed.add(label);
		}
		await sleep(intervalMs);
	}

	return {
		firstAllOkMs,
		lastDisagreementMs,
		settledMs: null,
		mixedWindowMs: null,
		disagreedOn: [...disagreed],
		attempts,
		timedOut: true
	};
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function describePropagation(p) {
	const disagreed = p.disagreedOn?.length ? `; disagreed on: ${p.disagreedOn.join(', ')}` : '';
	if (p.timedOut) {
		return `NEVER settled: first full agreement at ${p.firstAllOkMs ?? 'never'} ms, still disagreeing after ${p.attempts} rounds${disagreed}`;
	}
	return `first agreement ${p.firstAllOkMs} ms, settled ${p.settledMs} ms, mixed window ${p.mixedWindowMs} ms, ${p.attempts} rounds${disagreed}`;
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function d1Execute(sql) {
	await execFileAsync(
		'npx',
		[
			'wrangler',
			'd1',
			'execute',
			process.env.CAMPAIGN_STAGING_D1_NAME ?? 'guild-book-staging-db',
			'--remote',
			'--env',
			WRANGLER_ENV,
			'--command',
			sql
		],
		{ maxBuffer: 1024 * 1024 * 32 }
	);
}

async function seedFixtureUsers(ids) {
	const values = ids.map((id) => `('${id}','${id}')`).join(',');
	await d1Execute(`INSERT OR IGNORE INTO users (id, name) VALUES ${values}`);
}

function blankCharacter(name) {
	const attributes = {};
	for (const suit of ['swords', 'pentacles', 'cups', 'wands']) {
		attributes[suit] = { value: 0, sources: [] };
	}
	return {
		schemaVersion: 1,
		system: 'hmtw',
		contentPackId: 'hmtw',
		name,
		pronouns: '',
		appearance: '',
		portraitUrl: '',
		kithId: null,
		kinId: null,
		pathId: null,
		attributes,
		talents: [],
		quest: '',
		motifs: [],
		bonds: [],
		life: { status: 'alive' },
		resolve: { current: 4, max: 4 },
		arete: { triggersMet: [false, false, false], talentEarned: false },
		languages: [],
		conditions: [],
		afflictions: [],
		lore: 4,
		experience: 0,
		equipment: [],
		notes: '',
		isDraft: true,
		wizardStep: 0
	};
}

/**
 * The GM's current session version, read directly rather than inferred — every
 * lifecycle transition claims a version and a stale one is a deliberate 409.
 *
 * Returns `{ok, version, status}` rather than a bare number, because the failure
 * mode matters. This previously returned `null` on any non-200, the caller put
 * that straight into the request body, and `expectedVersion: null` is rejected
 * by the PATCH route's strict zod schema (`z.number().optional()` accepts
 * *omitted*, not *null*) with a 400 — indistinguishable at a glance from the
 * lifecycle layer's own 400 for an illegal transition. A read failure must
 * surface as a read failure.
 */
async function readSessionVersion(gm, campaignId, sessionId) {
	const res = await request(`/api/campaigns/${campaignId}/sessions/${sessionId}`, { actor: gm });
	const version = res.json?.session?.sessionVersion;
	return {
		ok: res.status === 200 && typeof version === 'number',
		version: typeof version === 'number' ? version : undefined,
		status: res.status
	};
}

/** A lifecycle PATCH body that OMITS `expectedVersion` when it is unknown,
 * rather than sending null. Omitted means "act regardless of version", which is
 * a supported and documented choice; null is a schema violation. */
function lifecycleBody(action, read) {
	return read?.ok ? { action, expectedVersion: read.version } : { action };
}

// ---------------------------------------------------------------------------
// The rehearsal
// ---------------------------------------------------------------------------

const gm = newActor(`${PREFIX}-gm`, 'operator/GM');
const playerA = newActor(`${PREFIX}-p1`, 'player A');
const playerB = newActor(`${PREFIX}-p2`, 'player B');

let campaignId = null;
let sessionId = null;
let inviteToken = null;
let shareId = null;
let endedChecksum = null;

try {
	await run();
} catch (err) {
	console.error(`\n✘ rehearsal aborted: ${err?.message ?? err}`);
	failures.push(`aborted: ${err?.message ?? err}`);
} finally {
	await restoreStaging();
	await finish();
}

async function run() {
	// -----------------------------------------------------------------------
	phase('Preflight');
	// -----------------------------------------------------------------------
	const before = await health();
	if (before.status !== 200) {
		throw new Error(
			`health endpoint returned ${before.status} — check CAMPAIGN_HEALTH_SECRET matches staging (it 404s on a wrong secret, by design)`
		);
	}
	check(before.json.campaignsEnabled === true, 'staging starts with campaigns ENABLED', `campaignsEnabled=${before.json.campaignsEnabled}`);
	check(before.json.database.reachable === true, 'staging D1 is reachable');
	note(`migrations applied: ${before.json.database.migrationsApplied}`);
	note(`content digest: ${before.json.content?.runtimeDigest ?? 'n/a'}`);
	note(`rate-limit enforcement: ${before.json.rateLimit.enforcement}`);
	report.healthBefore = sanitizeHealth(before.json);

	if (!SKIP_BUILD) {
		console.log('   → building (ADAPTER=cloudflare npm run build)');
		const buildStart = Date.now();
		await execFileAsync('npm', ['run', 'build'], {
			env: { ...process.env, ADAPTER: 'cloudflare' },
			maxBuffer: 1024 * 1024 * 64
		});
		note(`build completed in ${((Date.now() - buildStart) / 1000).toFixed(1)}s`);
	} else {
		note('reusing the existing .svelte-kit/cloudflare build (--skip-build)');
	}

	// -----------------------------------------------------------------------
	phase('Phase 1 — an active staging session, and its aggregate health');
	// -----------------------------------------------------------------------
	await seedFixtureUsers([gm.userId, playerA.userId, playerB.userId]);
	await Promise.all([signIn(gm), signIn(playerA), signIn(playerB)]);
	note(`seeded 3 fixture users under ${PREFIX}`);

	const created = await request('/api/campaigns', {
		method: 'POST',
		actor: gm,
		body: { name: `${PREFIX} rollback rehearsal` }
	});
	if (created.status !== 200 && created.status !== 201) {
		throw new Error(`campaign create returned ${created.status}`);
	}
	campaignId = created.json.campaign.id;
	inviteToken = created.json.inviteToken;
	note(`campaign ${campaignId}`);

	for (const player of [playerA, playerB]) {
		const joined = await request(`/api/campaigns/join/${inviteToken}`, {
			method: 'POST',
			actor: player,
			body: { joinWithoutCharacter: true }
		});
		if (joined.status !== 200 && joined.status !== 201) {
			throw new Error(`${player.label} join returned ${joined.status}`);
		}
	}
	note('both players joined');

	const started = await request(`/api/campaigns/${campaignId}/sessions`, { method: 'POST', actor: gm, body: {} });
	if (started.status !== 200 && started.status !== 201) throw new Error(`session start returned ${started.status}`);
	sessionId = started.json.sessionId;
	note(`session ${sessionId} active`);

	// Real public state, so "public history survived" later is a claim about
	// something that actually existed rather than about an empty log.
	const gmVersion = started.json.session.sessionVersion;
	const drew = await request(`/api/campaigns/${campaignId}/sessions/${sessionId}/commands`, {
		method: 'POST',
		actor: gm,
		body: {
			commandId: randomUUID(),
			observedSessionVersion: gmVersion,
			expectedStructuralVersion: gmVersion,
			command: { type: 'end-round' }
		}
	});
	check(drew.status === 200 && drew.json?.outcome?.ok === true, 'a command is accepted before the rollback', `status ${drew.status}`);

	// A character with a public share link, created BEFORE the rollback. Phase 3
	// asserts the link still resolves while campaigns are off — a real check
	// that the flag scopes to campaigns, not a probe of an unrelated static page.
	const character = await request('/api/characters', {
		method: 'POST',
		actor: gm,
		body: { character: blankCharacter(`${PREFIX} adventurer`) }
	});
	if (character.status === 200 || character.status === 201) {
		const characterId = character.json.id ?? character.json.characterId;
		// A DRAFT cannot be shared — `share.ts:37` returns 409, which is correct
		// product behaviour and is why this check was silently skipped on the
		// first two rehearsal runs. Finalizing by SQL rather than driving the
		// whole creation wizard keeps this focused on the rollback boundary,
		// exactly as `staging-d1-smoke.mjs` does for the attachment race. Both
		// the column and the JSON blob carry the flag and both are read.
		await d1Execute(
			`UPDATE characters SET is_draft = 0, data = json_set(data, '$.isDraft', json('false')) WHERE id = '${characterId}'`
		);
		const shared = await request(`/api/characters/${characterId}/share`, { method: 'POST', actor: gm });
		if (shared.status === 200) {
			shareId = shared.json.shareId;
			note('a shared adventurer link exists for the phase 3 boundary check');
		} else {
			note(`share mint returned ${shared.status}; the sharing check will be skipped rather than faked`);
		}
	} else {
		note(`character create returned ${character.status}; the sharing check will be skipped rather than faked`);
	}

	const activeHealth = await health();
	check(activeHealth.json?.database?.activeSessions >= 1, 'health reports at least one active session', `activeSessions=${activeHealth.json?.database?.activeSessions}`);
	report.healthWithActiveSession = sanitizeHealth(activeHealth.json);

	// -----------------------------------------------------------------------
	phase('Phase 2 — deploy the rollback (CAMPAIGNS_ENABLED=false, empty allowlist)');
	// -----------------------------------------------------------------------
	restoreNeeded = true;
	const offDeploy = await deploy('campaigns OFF, no allowlist', { campaignsEnabled: 'false', pilotUserIds: '' });
	const offProp = await measurePropagation(offDeploy, [
		{
			label: 'GM refused',
			holds: async () => (await request(`/api/campaigns/${campaignId}/sync?after=0&version=0`, { actor: gm })).status === 404
		},
		{
			label: 'player refused',
			holds: async () => (await request(`/api/campaigns/${campaignId}/sync?after=0&version=0`, { actor: playerA })).status === 404
		},
		{
			label: 'campaign list refused',
			holds: async () => (await request('/api/campaigns', { actor: gm })).status === 404
		},
		{
			label: 'health reports disabled',
			holds: async () => (await health()).json?.campaignsEnabled === false
		}
	]);
	check(!offProp.timedOut, 'the rollback reached the edge and STAYED there', describePropagation(offProp));
	note(`campaigns remained reachable somewhere for ${offProp.lastDisagreementMs ?? 0} ms after the deploy returned`);
	report.disablePropagation = { ...offProp, deployMs: offDeploy.deployMs, version: offDeploy.version };

	const offHealth = await health();
	check(offHealth.json?.campaignsEnabled === false, 'health confirms the flag is off');
	check(offHealth.json?.pilotAllowlistSize === 0, 'the pilot allowlist is empty', `size=${offHealth.json?.pilotAllowlistSize}`);

	// -----------------------------------------------------------------------
	phase('Phase 3 — the feature is gone; the rest of the site is not');
	// -----------------------------------------------------------------------
	const campaignRoutes = [
		['GET', '/campaigns', gm],
		['GET', `/campaigns/${campaignId}`, gm],
		['GET', `/campaigns/${campaignId}/table`, gm],
		['GET', '/api/campaigns', gm],
		['GET', `/api/campaigns/${campaignId}`, gm],
		['GET', `/api/campaigns/${campaignId}/sync?after=0&version=0`, playerA],
		['GET', `/api/campaigns/${campaignId}/sessions/${sessionId}`, playerB],
		['GET', `/join/${inviteToken}`, playerA]
	];
	for (const [method, path, actor] of campaignRoutes) {
		const res = await request(path, { method, actor });
		check(res.status === 404, `${method} ${redactToken(path)} → 404 for ${actor.label}`, `got ${res.status}`);
	}

	// Mutations must be refused too, not merely hidden from navigation.
	const blockedCommand = await request(`/api/campaigns/${campaignId}/sessions/${sessionId}/commands`, {
		method: 'POST',
		actor: gm,
		body: {
			commandId: randomUUID(),
			observedSessionVersion: 99,
			expectedStructuralVersion: 99,
			command: { type: 'end-round' }
		}
	});
	check(blockedCommand.status === 404, 'a session command is refused with 404, not merely hidden', `got ${blockedCommand.status}`);

	const blockedJoin = await request(`/api/campaigns/join/${inviteToken}`, {
		method: 'POST',
		actor: playerA,
		body: { joinWithoutCharacter: true }
	});
	check(blockedJoin.status === 404, 'an invite join is refused with 404', `got ${blockedJoin.status}`);

	// The rest of the product. A 200 or a redirect to login both mean "this
	// route still works"; a 404 or 5xx would mean the rollback took the site
	// with it, which is the failure mode this phase exists to catch.
	const survivingRoutes = [
		['/', null],
		['/characters', gm],
		['/rules', null],
		['/denizens', null],
		['/deck', null],
		['/login', null],
		['/licensing', null],
		['/api/characters', gm],
		// Authenticated deliberately: `GET /api/denizens` calls `ensureUser`, so an
		// anonymous probe gets a 401 that says nothing about whether the rollback
		// broke it. Widening the accepted statuses to swallow the 401 would also
		// swallow a route that had genuinely started demanding auth.
		['/api/denizens', gm]
	];
	for (const [path, actor] of survivingRoutes) {
		const res = await request(path, { actor });
		check(res.status === 200 || res.status === 302 || res.status === 304, `${path} still serves`, `status ${res.status}`);
	}

	if (shareId) {
		// Unauthenticated, exactly as a person following a shared link.
		const shared = await request(`/s/${shareId}`);
		check(shared.status === 200, 'a public adventurer share link still resolves', `status ${shared.status}`);
	} else {
		note('sharing check skipped — no share link was minted in phase 1');
	}

	// `Server-Timing` is emitted only when CAMPAIGN_TIMING_HEADER is set. Its
	// presence here proves the `--var` override deploy did not wipe the other
	// staging vars along with the one it changed.
	const timingProbe = await request('/');
	check(!!timingProbe.serverTiming, 'the override deploy preserved the other staging vars', timingProbe.serverTiming ? 'Server-Timing present' : 'Server-Timing MISSING — vars were replaced');

	// -----------------------------------------------------------------------
	phase('Phase 4 — operator-only access, then close the session out');
	// -----------------------------------------------------------------------
	const pilotDeploy = await deploy('campaigns OFF, operator allowlisted', {
		campaignsEnabled: 'false',
		pilotUserIds: gm.userId
	});
	// The GM's 200 alone is NOT sufficient: a GM is allowed under this config and
	// under the fully-enabled one, so it cannot tell the allowlist landing apart
	// from campaigns never having gone off. The players' 404 is what excludes
	// the stale fully-enabled config, which is exactly what leaked through here
	// on 2026-07-29.
	const pilotProp = await measurePropagation(pilotDeploy, [
		{
			label: 'operator admitted',
			holds: async () => (await request(`/api/campaigns/${campaignId}/sessions/${sessionId}`, { actor: gm })).status === 200
		},
		{
			label: 'player A refused',
			holds: async () => (await request(`/api/campaigns/${campaignId}/sync?after=0&version=0`, { actor: playerA })).status === 404
		},
		{
			label: 'player B refused',
			holds: async () => (await request(`/api/campaigns/${campaignId}/sync?after=0&version=0`, { actor: playerB })).status === 404
		},
		{
			label: 'health reports disabled with a 1-entry allowlist',
			holds: async () => {
				const h = (await health()).json;
				return h?.campaignsEnabled === false && h?.pilotAllowlistSize === 1;
			}
		}
	]);
	check(!pilotProp.timedOut, 'operator access returned and settled', describePropagation(pilotProp));
	report.operatorRestorePropagation = { ...pilotProp, deployMs: pilotDeploy.deployMs, version: pilotDeploy.version };

	// The whole point of an allowlist restore: the operator is back in, and
	// nobody else is. A rollback that quietly readmits the public is not a
	// rollback.
	for (const player of [playerA, playerB]) {
		const res = await request(`/api/campaigns/${campaignId}/sync?after=0&version=0`, { actor: player });
		check(res.status === 404, `${player.label} is still locked out under the operator allowlist`, `got ${res.status}`);
	}

	// Freeze → recover → end, all three lifecycle transitions under
	// operator-only access, which is the state an incident actually leaves.
	let version = await readSessionVersion(gm, campaignId, sessionId);
	check(version.ok, 'the operator can read the session before acting on it', `GET status ${version.status}`);
	const frozen = await request(`/api/campaigns/${campaignId}/sessions/${sessionId}`, {
		method: 'PATCH',
		actor: gm,
		body: lifecycleBody('freeze', version)
	});
	check(frozen.status === 200, 'the operator can freeze the stranded session', `status ${frozen.status}`);

	const frozenHealth = await health();
	check(frozenHealth.json?.database?.frozenSessions >= 1, 'health reports the frozen session', `frozenSessions=${frozenHealth.json?.database?.frozenSessions}`);
	note(`oldest frozen age: ${frozenHealth.json?.database?.oldestFrozenAgeSeconds}s`);

	// Archiving must stay blocked while a session is open — the tempting wrong
	// move during an incident.
	const blockedArchive = await request(`/api/campaigns/${campaignId}`, { method: 'DELETE', actor: gm });
	check(blockedArchive.status === 409, 'archiving is refused while the session is open', `got ${blockedArchive.status}`);

	version = await readSessionVersion(gm, campaignId, sessionId);
	check(version.ok, 'the frozen session is still readable by the operator', `GET status ${version.status}`);
	const recovered = await request(`/api/campaigns/${campaignId}/sessions/${sessionId}`, {
		method: 'PATCH',
		actor: gm,
		body: lifecycleBody('recover', version)
	});
	check(recovered.status === 200, 'the operator can recover the session', `status ${recovered.status}`);

	version = await readSessionVersion(gm, campaignId, sessionId);
	const ended = await request(`/api/campaigns/${campaignId}/sessions/${sessionId}`, {
		method: 'PATCH',
		actor: gm,
		body: lifecycleBody('end', version)
	});
	check(ended.status === 200, 'the operator can end the session', `status ${ended.status}`);
	endedChecksum = ended.json?.publicHistoryChecksum ?? null;
	check(!!endedChecksum, 'ending produced a public-history checksum');

	const history = await request(`/api/campaigns/${campaignId}/sessions/${sessionId}`, { actor: gm });
	check(history.status === 200 && history.json?.status === 'ended', 'public history is readable after the end', `status ${history.status}`);

	// -----------------------------------------------------------------------
	phase('Phase 5 — re-enable, and confirm nothing had to be migrated back');
	// -----------------------------------------------------------------------
	const onDeploy = await deploy('campaigns ON (restore wrangler.toml state)', null);
	restoreNeeded = false;
	const onProp = await measurePropagation(onDeploy, [
		{
			label: 'player A admitted',
			holds: async () => (await request(`/api/campaigns/${campaignId}/sessions/${sessionId}`, { actor: playerA })).status === 200
		},
		{
			label: 'player B admitted',
			holds: async () => (await request(`/api/campaigns/${campaignId}/sessions/${sessionId}`, { actor: playerB })).status === 200
		},
		{
			label: 'health reports enabled with an empty allowlist',
			holds: async () => {
				const h = (await health()).json;
				return h?.campaignsEnabled === true && h?.pilotAllowlistSize === 0;
			}
		}
	]);
	check(!onProp.timedOut, 'players regained access on re-enable', describePropagation(onProp));
	report.reEnablePropagation = { ...onProp, deployMs: onDeploy.deployMs, version: onDeploy.version };

	const after = await health();
	check(after.json?.campaignsEnabled === true, 'health confirms campaigns are enabled again');
	check(after.json?.pilotAllowlistSize === 0, 'the allowlist is empty again', `size=${after.json?.pilotAllowlistSize}`);
	check(
		after.json?.database?.migrationsApplied === before.json?.database?.migrationsApplied,
		'no migration was rolled back or reapplied',
		`${before.json?.database?.migrationsApplied} → ${after.json?.database?.migrationsApplied}`
	);
	check(
		after.json?.content?.runtimeDigest === before.json?.content?.runtimeDigest,
		'the content digest is unchanged across the whole rehearsal',
		`${before.json?.content?.runtimeDigest ?? 'n/a'} → ${after.json?.content?.runtimeDigest ?? 'n/a'}`
	);
	report.healthAfter = sanitizeHealth(after.json);

	// The session survived the round trip intact — same checksum, still readable
	// by a PLAYER now that the feature is public again.
	const playerHistory = await request(`/api/campaigns/${campaignId}/sessions/${sessionId}`, { actor: playerA });
	check(playerHistory.status === 200 && playerHistory.json?.status === 'ended', 'a player can read the public history after re-enable', `status ${playerHistory.status}`);
	check(
		playerHistory.json?.session?.checksum === undefined ||
			playerHistory.json?.session?.checksum === endedChecksum,
		'the public-history checksum is unchanged across the rollback cycle'
	);

	const archived = await request(`/api/campaigns/${campaignId}`, { method: 'DELETE', actor: gm });
	check(archived.status === 200, 'the fixture campaign archives cleanly', `status ${archived.status}`);
}

/** Runs on every exit path. A rehearsal that leaves staging disabled because it
 * threw in phase 3 is worse than one that never ran. */
async function restoreStaging() {
	if (!restoreNeeded) return;
	console.log('\n   ! restoring staging to its wrangler.toml state');
	try {
		await deploy('restore (campaigns ON)', null);
		restoreNeeded = false;
		console.log('   ✓ staging restored');
	} catch {
		console.error('\n✘✘ COULD NOT RESTORE STAGING. Campaigns are still DISABLED there.');
		console.error(`   Run this yourself: npx wrangler deploy --env ${WRANGLER_ENV}\n`);
	}
}

process.on('SIGINT', async () => {
	console.log('\n interrupted — restoring staging before exit');
	await restoreStaging();
	process.exit(130);
});

/** Aggregate only: never the allowlist ids, never a session payload. */
function sanitizeHealth(json) {
	if (!json) return null;
	return {
		campaignsEnabled: json.campaignsEnabled,
		pilotAllowlistSize: json.pilotAllowlistSize,
		rateLimitEnforcement: json.rateLimit?.enforcement,
		rateLimitBindingsPresent: json.rateLimit?.bindingsPresent?.length ?? null,
		rateLimitBindingsMissing: json.rateLimit?.bindingsMissing ?? [],
		databaseReachable: json.database?.reachable,
		migrationsApplied: json.database?.migrationsApplied,
		activeSessions: json.database?.activeSessions,
		frozenSessions: json.database?.frozenSessions,
		oldestFrozenAgeSeconds: json.database?.oldestFrozenAgeSeconds,
		contentDigest: json.content?.runtimeDigest ?? null
	};
}

/** Invite tokens are credentials. They appear in probe paths and must not
 * appear in output. */
function redactToken(path) {
	return path.replace(/\/join\/[^/?]+/, '/join/<token>');
}

async function finish() {
	console.log('\n=== Rollback rehearsal summary ===\n');
	const propagations = [
		['disable (campaigns → off)', report.disablePropagation],
		['operator allowlist restore', report.operatorRestorePropagation],
		['re-enable (campaigns → on)', report.reEnablePropagation]
	];
	for (const [label, p] of propagations) {
		if (!p) continue;
		console.log(
			`  ${label.padEnd(30)} deploy ${(p.deployMs / 1000).toFixed(1)}s | first agreement ${
				p.firstAllOkMs ?? '—'
			} ms | settled ${p.timedOut ? 'TIMED OUT' : `${p.settledMs} ms`} | mixed window ${
				p.mixedWindowMs ?? '—'
			} ms`
		);
	}
	// Counted from the checks themselves, not from `failures` — that list also
	// carries an abort message, which is not a check and must not make the
	// tally read as negative.
	const allChecks = report.phases.flatMap((ph) => ph.checks);
	const passed = allChecks.filter((c) => c.ok).length;
	console.log(`\n  checks: ${passed}/${allChecks.length} passed`);

	report.failures = failures;
	report.passed = failures.length === 0;

	if (REPORT_PATH) {
		await writeFile(REPORT_PATH, JSON.stringify(report, null, 2));
		console.log(`  report written to ${REPORT_PATH}`);
	}

	if (failures.length) {
		console.log('\n  FAILURES:');
		for (const f of failures) console.log(`    ✘ ${f}`);
		console.log('');
		process.exitCode = 1;
	} else {
		console.log('\n  ✓ rollback rehearsal passed\n');
	}
}
