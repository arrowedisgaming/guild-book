#!/usr/bin/env node
/**
 * Seed a stable pool of load-test fixture users into the STAGING D1 database.
 *
 * Run this once from a machine that has Cloudflare credentials. The load
 * harness can then reuse the pool via `CAMPAIGN_STAGING_USER_PREFIX`, which is
 * what lets CI run the capacity gate with only `AUTH_SECRET` and no Cloudflare
 * API token — seeding needs D1 write access, minting a session cookie for an
 * existing user does not.
 *
 * Idempotent: uses INSERT OR IGNORE, so re-running adds only missing rows.
 *
 * USAGE
 *   node scripts/campaigns/seed-load-fixtures.mjs [--count 27] [--prefix loadfix]
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const args = process.argv.slice(2);
function flag(name, fallback) {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
}

const count = Number(flag('count', 27));
const prefix = flag('prefix', 'loadfix');
const d1Name = process.env.CAMPAIGN_STAGING_D1_NAME ?? 'guild-book-staging-db';
const wranglerEnv = process.env.CAMPAIGN_STAGING_WRANGLER_ENV ?? 'staging';

if (!Number.isFinite(count) || count <= 0) {
	console.error('--count must be a positive number');
	process.exit(1);
}
if (d1Name.includes('staging') === false) {
	console.error(`Refusing to seed fixtures into "${d1Name}" — this script is for the staging database only.`);
	process.exit(1);
}

const ids = Array.from({ length: count }, (_, i) => `${prefix}-${i}`);
const values = ids.map((id) => `('${id}','${id}')`).join(',');

console.log(`Seeding ${count} fixture users as ${prefix}-0..${count - 1}`);
console.log(`  database: ${d1Name} (--env ${wranglerEnv})`);

const { stdout } = await execFileAsync(
	'npx',
	[
		'wrangler',
		'd1',
		'execute',
		d1Name,
		'--remote',
		'--env',
		wranglerEnv,
		'--command',
		`INSERT OR IGNORE INTO users (id, name) VALUES ${values}`
	],
	{ maxBuffer: 1024 * 1024 * 32 }
);

const rowsWritten = /rows_written["\s:]+(\d+)/.exec(stdout)?.[1] ?? 'unknown';
console.log(`Done. rows_written: ${rowsWritten} (0 means they already existed).`);
console.log(`\nRun the gate with:\n  CAMPAIGN_LOAD_TARGET=staging CAMPAIGN_STAGING_USER_PREFIX=${prefix} \\`);
console.log(`  CAMPAIGN_STAGING_AUTH_SECRET=<staging AUTH_SECRET> \\`);
console.log(`  node tests/load/session-polling.mjs --base-url <staging url> --duration 1800 --campaigns 9`);
