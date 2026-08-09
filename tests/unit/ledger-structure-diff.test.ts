import { describe, expect, it } from 'vitest';
import { diffChapter } from '../../scripts/content-import/ledger-structure-diff.mjs';

describe('ledger structure diff', () => {
	const ledgerChapter = {
		file: 'x.md',
		section: 'x',
		headings: [
			{ locator: 'Alpha', occurrence: 1, level: 1, disposition: 'emitted', id: 'x-alpha' },
			{ locator: 'Alpha/Beta', occurrence: 1, level: 2, disposition: 'emitted', id: 'x-beta' }
		]
	};

	it('reports a ledger heading missing from the vault as lost', () => {
		const { lost, added } = diffChapter(ledgerChapter, '# Alpha\n\nprose\n');
		expect(lost.map((h) => h.locator)).toEqual(['Alpha/Beta']);
		expect(added).toEqual([]);
	});

	it('reports a vault heading absent from the ledger as added', () => {
		const { lost, added } = diffChapter(ledgerChapter, '# Alpha\n\n## Beta\n\n### Gamma\n');
		expect(lost).toEqual([]);
		expect(added.map((h) => h.path)).toEqual(['Alpha/Beta/Gamma']);
	});

	it('distinguishes occurrences of the same path', () => {
		const { lost } = diffChapter(
			{ ...ledgerChapter, headings: [{ locator: 'Alpha', occurrence: 2, level: 1, disposition: 'emitted' }] },
			'# Alpha\n'
		);
		expect(lost.map((h) => h.occurrence)).toEqual([2]);
	});
});

// CLI coverage for --ledger (the flag Task 5's baseline audit depends on),
// including an absolute path outside the repo. The synthetic ledger uses a
// sentinel section and both emitted/skipped missing rows, so the test proves
// the flag is honored AND the summary counts emitted losses only. Needs the
// vault, so skipped in CI.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MD_DIR } from '../../scripts/content-import/md-lib.mjs';

describe.skipIf(!existsSync(MD_DIR))('ledger-structure-diff CLI', () => {
	it('honors an absolute --ledger path and counts only emitted losses', () => {
		const dir = mkdtempSync(join(tmpdir(), 'ledger-cli-test-'));
		const baseline = join(dir, 'baseline.json');
		writeFileSync(
			baseline,
			JSON.stringify([
				{
					file: '01 - Chapter 1 - The Basics.md',
					section: 'cli-ledger-sentinel',
					headings: [
						{
							locator: 'CLI emitted heading that does not exist',
							occurrence: 1,
							level: 1,
							disposition: 'emitted',
							id: 'cli-missing-emitted'
						},
						{
							locator: 'CLI skipped heading that does not exist',
							occurrence: 1,
							level: 2,
							disposition: 'skipped',
							reason: 'summary must not count this row'
						}
					]
				}
			])
		);

		try {
			const out = execFileSync(
				'node',
				['scripts/content-import/ledger-structure-diff.mjs', '--ledger', baseline],
				{ encoding: 'utf8' }
			);
			expect(out).toContain('=== cli-ledger-sentinel');
			expect(out).toContain('LOST L1 [emitted] CLI emitted heading that does not exist#1');
			expect(out).toContain('LOST L2 [skipped] CLI skipped heading that does not exist#1');
			expect(out).toContain('lost emitted headings require manifest attention: 1');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
