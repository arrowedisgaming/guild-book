import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateNewReleaseTag, validateReleaseTag } from '../../scripts/release/validate-tag.mjs';

const changelog = `# Changelog

## [Unreleased]

## [0.8.0] - 2026-07-31

## [0.9.0-beta.1] - 2026-08-01
`;

const validator = join(process.cwd(), 'scripts/release/validate-tag.mjs');

const fixtures: string[] = [];
afterAll(() => {
	for (const fixture of fixtures) rmSync(fixture, { recursive: true, force: true });
});

function createReleaseFixture(): string {
	const repository = mkdtempSync(join(tmpdir(), 'guild-book-release-tag-'));
	fixtures.push(repository);
	execFileSync('git', ['init', '--quiet'], { cwd: repository });
	execFileSync('git', ['config', 'user.name', 'Release Test'], { cwd: repository });
	execFileSync('git', ['config', 'user.email', 'release-test@example.invalid'], {
		cwd: repository
	});
	writeFileSync(join(repository, 'package.json'), '{"version":"0.8.0"}\n');
	writeFileSync(join(repository, 'CHANGELOG.md'), changelog);
	execFileSync('git', ['add', 'package.json', 'CHANGELOG.md'], { cwd: repository });
	execFileSync('git', ['commit', '--quiet', '-m', 'release fixture'], { cwd: repository });
	return repository;
}

describe('validateReleaseTag', () => {
	it('validates the current package version when the local CLI receives no tag', () => {
		const packageVersion = String(
			(JSON.parse(readFileSync('package.json', 'utf8')) as { version?: unknown }).version ?? ''
		);
		const { GITHUB_REF_NAME: _ignored, ...env } = process.env;
		const result = spawnSync(process.execPath, ['scripts/release/validate-tag.mjs'], {
			cwd: process.cwd(),
			encoding: 'utf8',
			env
		});

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain(`release validation passed for v${packageVersion}`);
	});

	it('accepts an exact stable version tag with a dated changelog release', () => {
		expect(validateReleaseTag('v0.8.0', '0.8.0', changelog)).toEqual([]);
	});

	it('accepts a semver prerelease when tag, package, and changelog agree', () => {
		expect(validateReleaseTag('v0.9.0-beta.1', '0.9.0-beta.1', changelog)).toEqual([]);
	});

	it('rejects a tag that does not exactly match the package version', () => {
		expect(validateReleaseTag('v0.8.1', '0.8.0', changelog)).toContain(
			'release tag v0.8.1 does not match package version 0.8.0'
		);
	});

	it.each(['0.8', '01.2.3', 'not-a-version'])('rejects malformed package semver %s', (version) => {
		expect(validateReleaseTag(`v${version}`, version, changelog)).toContain(
			`package version ${version} is not valid semantic versioning`
		);
	});

	it('rejects a version without a dated changelog heading', () => {
		expect(validateReleaseTag('v1.0.0', '1.0.0', changelog)).toContain(
			'changelog is missing a dated [1.0.0] release heading'
		);
	});

	it('rejects lightweight release tags when annotated metadata is required', () => {
		const repository = createReleaseFixture();
		execFileSync('git', ['tag', 'v0.8.0'], { cwd: repository });

		const lightweight = spawnSync(
			process.execPath,
			[validator, 'v0.8.0', '--require-annotated'],
			{ cwd: repository, encoding: 'utf8' }
		);
		expect(lightweight.status).toBe(1);
		expect(lightweight.stderr).toContain('release tag v0.8.0 must be annotated');

		execFileSync('git', ['tag', '--delete', 'v0.8.0'], { cwd: repository });
		execFileSync('git', ['tag', '--annotate', 'v0.8.0', '--message', 'Release v0.8.0'], {
			cwd: repository
		});
		const annotated = spawnSync(
			process.execPath,
			[validator, 'v0.8.0', '--require-annotated'],
			{ cwd: repository, encoding: 'utf8' }
		);
		expect(annotated.status, annotated.stderr).toBe(0);
	});

	it('rejects existing and regressing tags when a new release tag is required', () => {
		const repository = createReleaseFixture();
		execFileSync('git', ['tag', '--annotate', 'v0.8.0', '--message', 'Release v0.8.0'], {
			cwd: repository
		});

		const existing = spawnSync(process.execPath, [validator, 'v0.8.0', '--require-new'], {
			cwd: repository,
			encoding: 'utf8'
		});
		expect(existing.status).toBe(1);
		expect(existing.stderr).toContain(
			'release tag v0.8.0 already exists; fix forward with a new version'
		);

		const regressing = spawnSync(process.execPath, [validator, 'v0.7.9', '--require-new'], {
			cwd: repository,
			encoding: 'utf8'
		});
		expect(regressing.status).toBe(1);
		expect(regressing.stderr).toContain(
			'release tag v0.7.9 is lower than the newest existing release tag v0.8.0'
		);

		writeFileSync(join(repository, 'package.json'), '{"version":"0.9.0"}\n');
		writeFileSync(
			join(repository, 'CHANGELOG.md'),
			`# Changelog\n\n## [Unreleased]\n\n## [0.9.0] - 2026-08-02\n${changelog.slice('# Changelog\n\n## [Unreleased]\n'.length)}`
		);
		const advancing = spawnSync(process.execPath, [validator, 'v0.9.0', '--require-new'], {
			cwd: repository,
			encoding: 'utf8'
		});
		expect(advancing.status, advancing.stderr).toBe(0);
	});

	it('applies SemVer precedence to prereleases when a new release tag is required', () => {
		const repository = createReleaseFixture();
		execFileSync('git', ['tag', '--annotate', 'v0.8.0', '--message', 'Release v0.8.0'], {
			cwd: repository
		});

		expect(validateNewReleaseTag('v0.8.0-rc.1', repository)).toContain(
			'release tag v0.8.0-rc.1 is lower than the newest existing release tag v0.8.0'
		);
		expect(validateNewReleaseTag('v0.9.0-beta.2', repository)).toEqual([]);

		execFileSync(
			'git',
			['tag', '--annotate', 'v0.9.0-beta.2', '--message', 'Release v0.9.0-beta.2'],
			{ cwd: repository }
		);
		expect(validateNewReleaseTag('v0.9.0-beta.1', repository)).toContain(
			'release tag v0.9.0-beta.1 is lower than the newest existing release tag v0.9.0-beta.2'
		);
		expect(validateNewReleaseTag('v0.9.0-beta.10', repository)).toEqual([]);
		expect(validateNewReleaseTag('v0.9.0', repository)).toEqual([]);
	});

	it('fails closed when tag history cannot be read', () => {
		const missing = join(tmpdir(), 'guild-book-release-tag-missing');
		expect(validateNewReleaseTag('v9.9.9', missing)).toContain(
			'could not check whether release tag v9.9.9 exists; run inside the repository'
		);
	});
});
