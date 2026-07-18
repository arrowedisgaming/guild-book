import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Architectural-boundary enforcement for the whole shared-tarot-table
 * increment: every module under `src/lib/engine/session/` must stay pure —
 * no SvelteKit runtime, no server-only code, no DB, no network. Reads the
 * directory (rather than naming files) so modules Task 2/3 add later are
 * covered automatically.
 */

const SESSION_ENGINE_DIR = join(process.cwd(), 'src/lib/engine/session');

const FORBIDDEN_IMPORT_PREFIXES = [
	'$app/',
	'$env/',
	'$lib/server/',
	'@sveltejs/',
	'svelte',
	'drizzle-orm',
	'better-sqlite3',
	'@auth/',
	'node:http',
	'node:https',
	'node:net',
	'node:dns',
	'node:fs'
];

function importSpecifiers(source: string): string[] {
	const specifiers: string[] = [];
	const patterns = [
		/import\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g,
		/export\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g
	];
	for (const pattern of patterns) {
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(source))) {
			specifiers.push(match[1]);
		}
	}
	return specifiers;
}

const sessionEngineFiles = readdirSync(SESSION_ENGINE_DIR).filter((file) => file.endsWith('.ts'));

describe('session engine import boundaries', () => {
	it('finds session engine modules to check', () => {
		expect(sessionEngineFiles.length).toBeGreaterThan(0);
	});

	it.each(sessionEngineFiles)('%s imports nothing from app/server/sveltekit/db/network modules', (file) => {
		const source = readFileSync(join(SESSION_ENGINE_DIR, file), 'utf-8');
		const specifiers = importSpecifiers(source);

		for (const specifier of specifiers) {
			const violation = FORBIDDEN_IMPORT_PREFIXES.find(
				(prefix) => specifier === prefix || specifier.startsWith(prefix)
			);
			expect(violation, `${file} imports forbidden module "${specifier}"`).toBeUndefined();
		}
	});
});
