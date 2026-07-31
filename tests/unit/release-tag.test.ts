import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { validateReleaseTag } from '../../scripts/release/validate-tag.mjs';

const changelog = `# Changelog

## [Unreleased]

## [0.8.0] - 2026-07-31

## [0.9.0-beta.1] - 2026-08-01
`;

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
});
