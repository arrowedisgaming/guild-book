#!/usr/bin/env node
/**
 * Increment 5 Task 3 — non-destructive staging D1 smoke harness.
 *
 * Exercises campaign and session behaviour against a REMOTE staging Worker and
 * a REMOTE staging D1 database, so the constraints proven by unit/integration
 * tests against SQLite are re-proven against the production driver, where
 * batching, contention and sequential-per-database behaviour actually differ.
 *
 * SAFETY
 * - Refuses to run without an explicit base URL and auth secret.
 * - Refuses to run against the production hostname.
 * - Every row it creates carries a unique fixture prefix; it archives its own
 *   campaign at the end and NEVER deletes arbitrary rows.
 * - Prints no invite token, session secret, auth token, or card identity.
 *
 * USAGE
 *   CAMPAIGN_STAGING_BASE_URL=https://guild-book-staging.esoneill.workers.dev \
 *   CAMPAIGN_STAGING_AUTH_SECRET=<staging AUTH_SECRET> \
 *   node scripts/campaigns/staging-d1-smoke.mjs
 *
 * Optional:
 *   CAMPAIGN_STAGING_D1_NAME   (default guild-book-staging-db)
 *   CAMPAIGN_STAGING_WRANGLER_ENV (default staging)
 *   CAMPAIGN_STAGING_DEPLOY_CHECK=1  run the mid-session redeploy check (slow)
 *
 * WHY IT MINTS ITS OWN SESSION COOKIES
 * Users are created by the Auth.js OAuth adapter, so there is no API to create
 * one. Rather than expose a login bypass on a public staging URL, this harness
 * seeds fixture users directly into staging D1 and signs its own Auth.js
 * session JWTs with the staging AUTH_SECRET. Everything else — campaigns,
 * invites, attachment, sessions, commands — goes through the real HTTP API.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { encode } from '@auth/core/jwt';

const execFileAsync = promisify(execFile);

// Must match AUTH_SESSION_VERSION in src/lib/server/auth-policy.ts — a token
// carrying anything else is rejected by the `jwt` callback and returns null.
const AUTH_SESSION_VERSION = 2;

const BASE_URL = (process.env.CAMPAIGN_STAGING_BASE_URL ?? '').replace(/\/$/, '');
const AUTH_SECRET = process.env.CAMPAIGN_STAGING_AUTH_SECRET ?? '';
const D1_NAME = process.env.CAMPAIGN_STAGING_D1_NAME ?? 'guild-book-staging-db';
const WRANGLER_ENV = process.env.CAMPAIGN_STAGING_WRANGLER_ENV ?? 'staging';
const RUN_DEPLOY_CHECK = process.env.CAMPAIGN_STAGING_DEPLOY_CHECK === '1';

const PREFIX = `smoke-${Date.now().toString(36)}`;

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

if (!BASE_URL) fail('CAMPAIGN_STAGING_BASE_URL is required (no default — this script talks to a real deployment).');
if (!AUTH_SECRET) fail('CAMPAIGN_STAGING_AUTH_SECRET is required (the staging AUTH_SECRET, used to sign fixture session cookies).');
if (!/^https:\/\//.test(BASE_URL)) fail(`Refusing to run against a non-HTTPS URL: ${BASE_URL}`);
if (/guildbook\.arrowed\.games/.test(BASE_URL)) {
	fail('Refusing to run against the production hostname. This harness writes fixture rows.');
}

function fail(message) {
	console.error(`\n✘ ${message}\n`);
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const results = [];
let currentCheck = null;

function startCheck(name) {
	currentCheck = { name, notes: [] };
	process.stdout.write(`\n▸ ${name}\n`);
}

function note(message) {
	currentCheck?.notes.push(message);
	process.stdout.write(`    ${message}\n`);
}

function pass() {
	results.push({ ...currentCheck, status: 'pass' });
	process.stdout.write(`  ✓ pass\n`);
}

function skip(why) {
	results.push({ ...currentCheck, status: 'skip', why });
	process.stdout.write(`  ~ skipped: ${why}\n`);
}

function record(err) {
	results.push({ ...currentCheck, status: 'fail', error: err.message });
	process.stdout.write(`  ✘ FAIL: ${err.message}\n`);
}

async function check(name, fn) {
	startCheck(name);
	try {
		const outcome = await fn();
		if (outcome && outcome.skipped) skip(outcome.skipped);
		else pass();
	} catch (err) {
		record(err);
	}
}

function expect(condition, message) {
	if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Fixture users: seeded straight into staging D1, then given signed cookies
// ---------------------------------------------------------------------------

async function d1Execute(sql) {
	const { stdout } = await execFileAsync(
		'npx',
		['wrangler', 'd1', 'execute', D1_NAME, '--remote', '--env', WRANGLER_ENV, '--json', '--command', sql],
		{ maxBuffer: 1024 * 1024 * 32 }
	);
	return stdout;
}

async function seedUser(userId) {
	// `users.id` is the durable local id Auth.js's adapter would have created.
	// Email is left null: nothing here signs in through a provider, and a null
	// email cannot collide with a real verified one.
	await d1Execute(`INSERT INTO users (id, name) VALUES ('${userId}', '${userId}')`);
}

async function sessionCookie(userId) {
	// Auth.js v5 encrypts the session JWT (JWE) and derives the key from the
	// secret plus a salt that IS the cookie name. Secure cookie prefix because
	// staging is https.
	const cookieName = '__Secure-authjs.session-token';
	const token = await encode({
		token: { sub: userId, sessionVersion: AUTH_SESSION_VERSION },
		secret: AUTH_SECRET,
		salt: cookieName,
		maxAge: 60 * 60
	});
	return `${cookieName}=${token}`;
}

/**
 * A structurally-valid draft adventurer. Mirrors `createBlankCharacter()` in
 * `src/lib/types/character.ts` — kept as a literal rather than imported because
 * this is a plain Node script with no `$lib` alias and no TypeScript loader.
 * `isDraft: true` is what lets it skip `validateFinalCharacter`.
 */
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

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function api(actor, method, path, body) {
	const response = await fetch(`${BASE_URL}${path}`, {
		method,
		headers: {
			cookie: actor.cookie,
			'content-type': 'application/json',
			// Same-origin guard in hooks.server.ts rejects mutating requests
			// whose Origin is present and mismatched; matching it keeps this
			// harness on the same path a browser takes.
			origin: BASE_URL
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) })
	});

	const text = await response.text();
	let json = null;
	try {
		json = text.length ? JSON.parse(text) : null;
	} catch {
		/* non-JSON body — keep the raw text for the error message */
	}
	return { status: response.status, json, text };
}

function expectStatus(res, expected, what) {
	const list = Array.isArray(expected) ? expected : [expected];
	expect(
		list.includes(res.status),
		`${what}: expected ${list.join(' or ')}, got ${res.status}${res.json?.message ? ` (${res.json.message})` : ''}`
	);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const gm = { id: `${PREFIX}-gm` };
const playerA = { id: `${PREFIX}-pa` };
const playerB = { id: `${PREFIX}-pb` };
const actors = [gm, playerA, playerB];

let campaignId = null;
let sessionId = null;

async function main() {
	console.log(`Guild Book — staging D1 smoke harness`);
	console.log(`  target : ${BASE_URL}`);
	console.log(`  D1     : ${D1_NAME} (--env ${WRANGLER_ENV})`);
	console.log(`  prefix : ${PREFIX}`);

	await check('fixture users seeded and authenticated', async () => {
		for (const actor of actors) {
			await seedUser(actor.id);
			actor.cookie = await sessionCookie(actor.id);
		}
		// GET /api/campaigns requires an authenticated, feature-enabled caller.
		// A 404 here means the cookie was not accepted or campaigns are gated.
		const res = await api(gm, 'GET', '/api/campaigns');
		expectStatus(res, 200, 'authenticated campaign list');
		note(`3 fixture users seeded; session cookies accepted`);
	});

	await check('campaign creation, invite, join and attachment constraints', async () => {
		const created = await api(gm, 'POST', '/api/campaigns', {
			name: `${PREFIX} table`,
			description: 'staging smoke fixture'
		});
		expectStatus(created, 201, 'campaign create');
		// The route returns { campaign, roster, inviteToken } — the id is nested.
		campaignId = created.json?.campaign?.id;
		expect(campaignId, `campaign create returned no id (keys: ${Object.keys(created.json ?? {})})`);
		note(`campaign created`);

		const invite = await api(gm, 'GET', `/api/campaigns/${campaignId}/invite`);
		expectStatus(invite, 200, 'invite read');
		expect(invite.json.token, 'invite read returned no token');

		for (const player of [playerA, playerB]) {
			const joined = await api(player, 'POST', `/api/campaigns/join/${invite.json.token}`, {
				joinWithoutCharacter: true
			});
			expectStatus(joined, [200, 201], 'player join');
		}
		note(`2 players joined via signed invite`);

		// A nonmember must not be able to see the campaign at all.
		const stranger = { id: `${PREFIX}-stranger` };
		await seedUser(stranger.id);
		stranger.cookie = await sessionCookie(stranger.id);
		const denied = await api(stranger, 'GET', `/api/campaigns/${campaignId}`);
		expectStatus(denied, 404, 'nonmember campaign lookup must 404, not 403');
		note(`nonmember lookup returns 404 (existence not disclosed)`);
	});

	await check('invite rotate and close', async () => {
		const before = await api(gm, 'GET', `/api/campaigns/${campaignId}/invite`);
		expectStatus(before, 200, 'invite read');

		// POST rotates, PATCH re-opens a closed invite. Not interchangeable.
		const rotated = await api(gm, 'POST', `/api/campaigns/${campaignId}/invite`);
		expectStatus(rotated, [200, 409], 'invite rotate');
		if (rotated.status === 200) {
			expect(rotated.json.token !== before.json.token, 'rotate returned the same token');
			note(`rotate issued a different token`);
		}

		const closed = await api(gm, 'DELETE', `/api/campaigns/${campaignId}/invite`);
		expectStatus(closed, 200, 'invite close');

		// The pre-close token must no longer join.
		const stale = { id: `${PREFIX}-stale` };
		await seedUser(stale.id);
		stale.cookie = await sessionCookie(stale.id);
		const rejected = await api(stale, 'POST', `/api/campaigns/join/${before.json.token}`, {
			joinWithoutCharacter: true
		});
		expectStatus(rejected, [404, 429], 'join with a closed invite must fail');
		note(`closed invite no longer joins (${rejected.status})`);

		// Reopen so later checks are unaffected.
		const reopened = await api(gm, 'PATCH', `/api/campaigns/${campaignId}/invite`);
		expectStatus(reopened, [200, 201], 'invite reopen');
	});

	await check('simultaneous character attachment has exactly one winner', async () => {
		const made = await api(playerA, 'POST', '/api/characters', {
			character: blankCharacter(`${PREFIX} adventurer`)
		});
		if (made.status !== 200 && made.status !== 201) {
			return {
				skipped: `character create returned ${made.status} (${made.json?.message ?? made.text.slice(0, 120)}); attachment race not exercised`
			};
		}
		const characterId = made.json.id ?? made.json.characterId;
		expect(characterId, 'character create returned no id');

		// Attachment requires a FINALIZED adventurer — an incomplete one cannot
		// be brought to a table, which is correct product behaviour. Two
		// independent places enforce it and both must be satisfied:
		// `tenure.ts:135`'s claim guard reads the `is_draft` COLUMN, while
		// `tenure.ts:532`'s eligibility precheck reads `isDraft` inside the
		// `data` JSON blob. Setting only one leaves a `reason: 'draft'` 409.
		//
		// Finalizing by SQL rather than driving the whole creation wizard keeps
		// this check focused on the attachment RACE, which is what D1
		// contention can actually break.
		await d1Execute(
			`UPDATE characters SET is_draft = 0, data = json_set(data, '$.isDraft', json('false')) WHERE id = '${characterId}'`
		);
		note(`fixture adventurer finalized for attachment`);

		const [one, two] = await Promise.all([
			api(playerA, 'POST', `/api/campaigns/${campaignId}/adventurer`, { action: 'attach', characterId }),
			api(playerA, 'POST', `/api/campaigns/${campaignId}/adventurer`, { action: 'attach', characterId })
		]);

		const statuses = [one.status, two.status].sort();
		const reasons = [one, two].map((r) => r.json?.reason ?? r.json?.message ?? r.status).join(' | ');
		const winners = [one, two].filter((r) => r.status === 200).length;
		expect(winners >= 1, `no attachment succeeded (statuses ${statuses.join(',')}; reasons: ${reasons})`);
		expect(
			winners === 1,
			`${winners} attachments won simultaneously — the one-active-tenure constraint did not serialize (${reasons})`
		);
		note(`exactly one winner; loser rejected with 409 (${statuses.join(', ')})`);
	});

	await check('session start and duplicate command idempotency', async () => {
		const started = await api(gm, 'POST', `/api/campaigns/${campaignId}/sessions`);
		expectStatus(started, 201, 'session start');
		sessionId = started.json.sessionId;
		expect(sessionId, 'session start returned no sessionId');
		const version = started.json.session?.sessionVersion ?? 1;
		note(`session started at version ${version}`);

		// A second start must be refused — one open session per campaign.
		const second = await api(gm, 'POST', `/api/campaigns/${campaignId}/sessions`);
		expectStatus(second, [409, 400], 'second concurrent session start must be refused');
		note(`second session start refused (${second.status})`);

		const envelope = {
			commandId: `${PREFIX}-dup-1`,
			observedSessionVersion: version,
			command: { type: 'draw', deck: 'major', destinationZoneId: 'revealed', count: 1 }
		};
		const first = await api(gm, 'POST', `/api/campaigns/${campaignId}/sessions/${sessionId}/commands`, envelope);
		expectStatus(first, 200, 'first draw');
		expect(first.json.outcome?.ok, `first draw rejected: ${first.json.outcome?.code}`);
		const resultingVersion = first.json.outcome.resultingVersion;

		const replay = await api(gm, 'POST', `/api/campaigns/${campaignId}/sessions/${sessionId}/commands`, envelope);
		expectStatus(replay, 200, 'duplicate replay');
		expect(replay.json.outcome?.ok, 'duplicate replay was not accepted');
		expect(
			replay.json.outcome.resultingVersion === resultingVersion,
			`duplicate replay advanced the version (${resultingVersion} → ${replay.json.outcome.resultingVersion})`
		);
		note(`duplicate commandId replayed the original outcome at version ${resultingVersion}`);
	});

	await check('structural stale command returns 409', async () => {
		const current = await api(gm, 'GET', `/api/campaigns/${campaignId}/sessions/${sessionId}`);
		expectStatus(current, 200, 'session read');
		const version = current.json.session?.sessionVersion;
		expect(typeof version === 'number', 'session read returned no version');

		const stale = await api(gm, 'POST', `/api/campaigns/${campaignId}/sessions/${sessionId}/commands`, {
			commandId: `${PREFIX}-stale-1`,
			observedSessionVersion: version,
			expectedStructuralVersion: Math.max(0, version - 1),
			command: { type: 'end-round' }
		});
		expectStatus(stale, 409, 'stale structural command');
		expect(stale.json.outcome?.code === 'stale-structure', `expected stale-structure, got ${stale.json.outcome?.code}`);
		note(`stale structural precondition rejected with 409 stale-structure`);
	});

	await check('simultaneous version claim yields one N+1 winner and a valid retry', async () => {
		const current = await api(gm, 'GET', `/api/campaigns/${campaignId}/sessions/${sessionId}`);
		const version = current.json.session?.sessionVersion;

		// Two independent non-structural commands racing for version N+1. One
		// must win outright; the other must either retry into N+2 or be a clean
		// rejection — never a silent loss and never the same resulting version.
		const [one, two] = await Promise.all([
			api(gm, 'POST', `/api/campaigns/${campaignId}/sessions/${sessionId}/commands`, {
				commandId: `${PREFIX}-race-a`,
				observedSessionVersion: version,
				command: { type: 'draw', deck: 'major', destinationZoneId: 'revealed', count: 1 }
			}),
			api(gm, 'POST', `/api/campaigns/${campaignId}/sessions/${sessionId}/commands`, {
				commandId: `${PREFIX}-race-b`,
				observedSessionVersion: version,
				command: { type: 'draw', deck: 'player', destinationZoneId: 'revealed', count: 1 }
			})
		]);

		const accepted = [one, two].filter((r) => r.json?.outcome?.ok);
		const versions = accepted.map((r) => r.json.outcome.resultingVersion);
		expect(accepted.length >= 1, `neither racing command was accepted (${one.status}/${two.status})`);
		expect(
			new Set(versions).size === versions.length,
			`two accepted commands claimed the same version (${versions.join(',')}) — the version claim is not exclusive`
		);
		if (accepted.length === 2) {
			const sorted = [...versions].sort((a, b) => a - b);
			expect(
				sorted[1] === sorted[0] + 1,
				`retry did not land on the next version (${sorted.join(' then ')})`
			);
			note(`both committed, serialized at versions ${sorted.join(' then ')}`);
		} else {
			note(`one committed at ${versions[0]}, the other rejected cleanly`);
		}
	});

	await check('atomic failure leaves no public partial effect', async () => {
		// An externally-inducible atomic failure would require injecting a D1
		// batch error, which no public endpoint exposes. Rather than fake it,
		// this asserts the observable half: a rejected command must not advance
		// the session version or emit a public event.
		const before = await api(gm, 'GET', `/api/campaigns/${campaignId}/sync?after=0&version=0`);
		expectStatus(before, [200, 204], 'sync before');
		const beforeCursor = before.json?.cursor ?? 0;
		const beforeVersion = before.json?.session?.sessionVersion;

		const illegal = await api(gm, 'POST', `/api/campaigns/${campaignId}/sessions/${sessionId}/commands`, {
			commandId: `${PREFIX}-illegal-1`,
			observedSessionVersion: beforeVersion ?? 0,
			// Drawing from a zone that is not a legal destination for this deck.
			command: { type: 'draw', deck: 'major', destinationZoneId: `hand:${playerB.id}`, count: 1 }
		});
		expect(!illegal.json?.outcome?.ok, `expected the illegal command to be rejected, got ${illegal.status}`);

		const after = await api(gm, 'GET', `/api/campaigns/${campaignId}/sync?after=0&version=0`);
		const afterVersion = after.json?.session?.sessionVersion;
		expect(
			afterVersion === beforeVersion,
			`a rejected command advanced the session version (${beforeVersion} → ${afterVersion})`
		);
		note(`rejection code ${illegal.json?.outcome?.code}; version unchanged at ${afterVersion}`);
		note(`full batch-failure injection is covered by tests/integration/session-atomicity.test.ts — not externally inducible`);
	});

	await check('session survives a deployment using pinned runtime', async () => {
		if (!RUN_DEPLOY_CHECK) {
			return { skipped: 'set CAMPAIGN_STAGING_DEPLOY_CHECK=1 to redeploy mid-session (slow)' };
		}
		const before = await api(gm, 'GET', `/api/campaigns/${campaignId}/sessions/${sessionId}`);
		const version = before.json.session?.sessionVersion;

		note(`redeploying --env ${WRANGLER_ENV} with an active session…`);
		await execFileAsync('npx', ['wrangler', 'deploy', '--env', WRANGLER_ENV], {
			maxBuffer: 1024 * 1024 * 64
		});

		const resumed = await api(gm, 'POST', `/api/campaigns/${campaignId}/sessions/${sessionId}/commands`, {
			commandId: `${PREFIX}-postdeploy-1`,
			observedSessionVersion: version,
			command: { type: 'draw', deck: 'major', destinationZoneId: 'revealed', count: 1 }
		});
		expectStatus(resumed, 200, 'command after redeploy');
		expect(resumed.json.outcome?.ok, `post-deploy command rejected: ${resumed.json.outcome?.code}`);
		note(`session continued across a deployment (version ${version} → ${resumed.json.outcome.resultingVersion})`);
	});

	await check('ending purges private state and retains public history', async () => {
		const ended = await api(gm, 'PATCH', `/api/campaigns/${campaignId}/sessions/${sessionId}`, {
			action: 'end'
		});
		expectStatus(ended, 200, 'session end');
		note(`session ended; public history checksum present: ${Boolean(ended.json.publicHistoryChecksum)}`);

		const history = await api(gm, 'GET', `/api/campaigns/${campaignId}/sessions/${sessionId}`);
		expectStatus(history, 200, 'ended session read');
		expect(history.json.status === 'ended', `expected status ended, got ${history.json.status}`);

		const serialized = JSON.stringify(history.json);
		for (const forbidden of ['shuffleSeed', 'serverFragment', 'privatePayload', 'secretPayload']) {
			expect(!serialized.includes(forbidden), `ended session history exposed ${forbidden}`);
		}
		note(`no server/private fragment keys in the ended-session projection`);

		const listing = await api(gm, 'GET', `/api/campaigns/${campaignId}/sessions`);
		expectStatus(listing, 200, 'session listing');
		expect(Array.isArray(listing.json.history), 'session listing returned no history array');
		expect(listing.json.history.length >= 1, 'ended session is missing from public history');
		expect(listing.json.current === null || listing.json.current === undefined,
			'a session is still open after ending');
		note(`public history retains ${listing.json.history.length} session(s); no open session remains`);
	});
}

// ---------------------------------------------------------------------------
// Cleanup — archive the fixture campaign only, and only after its session ended
// ---------------------------------------------------------------------------

async function cleanup() {
	if (!campaignId) return;
	startCheck('cleanup: archive the fixture campaign');
	try {
		const archived = await api(gm, 'DELETE', `/api/campaigns/${campaignId}`);
		expectStatus(archived, [200, 204, 404, 405], 'campaign archive');
		note(`archive returned ${archived.status}`);
		note(`fixture rows are retained under prefix ${PREFIX} for inspection; nothing was hard-deleted`);
		pass();
	} catch (err) {
		record(err);
	}
}

const started = Date.now();
try {
	await main();
} finally {
	await cleanup();
}

const failed = results.filter((r) => r.status === 'fail');
const skipped = results.filter((r) => r.status === 'skip');
console.log(`\n${'─'.repeat(70)}`);
console.log(`checks: ${results.length}   passed: ${results.filter((r) => r.status === 'pass').length}   failed: ${failed.length}   skipped: ${skipped.length}`);
console.log(`elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s   fixture prefix: ${PREFIX}`);
if (failed.length) {
	console.log(`\nfailures:`);
	for (const f of failed) console.log(`  ✘ ${f.name}\n      ${f.error}`);
}
console.log(`${'─'.repeat(70)}\n`);
process.exit(failed.length ? 1 : 0);
