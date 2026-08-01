import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

/**
 * @param {string} tag
 * @param {string} packageVersion
 * @param {string} changelog
 * @returns {string[]}
 */
export function validateReleaseTag(tag, packageVersion, changelog) {
	const errors = [];
	if (!SEMVER.test(packageVersion)) {
		errors.push(`package version ${packageVersion} is not valid semantic versioning`);
	}
	if (tag !== `v${packageVersion}`) {
		errors.push(`release tag ${tag} does not match package version ${packageVersion}`);
	}
	const escapedVersion = packageVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const releaseHeading = new RegExp(
		`^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`,
		'm'
	);
	if (!releaseHeading.test(changelog)) {
		errors.push(`changelog is missing a dated [${packageVersion}] release heading`);
	}
	return errors;
}

/**
 * @param {string} tag
 * @param {string} cwd
 * @returns {boolean}
 */
export function isAnnotatedReleaseTag(tag, cwd = process.cwd()) {
	return spawnSync('git', ['cat-file', '-e', `${tag}^{tag}`], {
		cwd,
		stdio: 'ignore'
	}).status === 0;
}

/**
 * @param {string} version
 * @returns {{ core: string[], prerelease: string[] } | null}
 */
function parseReleaseVersion(version) {
	const match = SEMVER.exec(version);
	if (!match) return null;
	return {
		core: [match[1], match[2], match[3]],
		prerelease: match[4] ? match[4].split('.') : []
	};
}

/**
 * SemVer guarantees numeric identifiers carry no leading zeros, so comparing
 * digit strings by length and then lexically is exact at any magnitude.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareIdentifiers(a, b) {
	const aNumeric = /^\d+$/.test(a);
	const bNumeric = /^\d+$/.test(b);
	if (aNumeric && bNumeric) {
		if (a.length !== b.length) return a.length - b.length;
	} else if (aNumeric !== bNumeric) {
		return aNumeric ? -1 : 1;
	}
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Full SemVer precedence, ignoring build metadata.
 * @param {{ core: string[], prerelease: string[] }} a
 * @param {{ core: string[], prerelease: string[] }} b
 * @returns {number}
 */
function compareReleaseVersions(a, b) {
	for (let i = 0; i < 3; i += 1) {
		const order = compareIdentifiers(a.core[i], b.core[i]);
		if (order !== 0) return order;
	}
	if (a.prerelease.length === 0 || b.prerelease.length === 0) {
		return b.prerelease.length - a.prerelease.length;
	}
	for (let i = 0; i < Math.min(a.prerelease.length, b.prerelease.length); i += 1) {
		const order = compareIdentifiers(a.prerelease[i], b.prerelease[i]);
		if (order !== 0) return order;
	}
	return a.prerelease.length - b.prerelease.length;
}

/**
 * Errors for proposing `tag` as a brand-new release in the repository at `cwd`:
 * the tag must not already exist, and it must be higher than every existing
 * `v*` release tag. Fetch tags first — only locally known tags are checked.
 * Only meaningful before the tag is created, so callers opt in with
 * `--require-new`; the CI workflow validates the already-pushed tag and must
 * not use it. Git failures are errors: this gate never fails open.
 * @param {string} tag
 * @param {string} cwd
 * @returns {string[]}
 */
export function validateNewReleaseTag(tag, cwd = process.cwd()) {
	const probe = spawnSync('git', ['rev-parse', '--quiet', '--verify', `refs/tags/${tag}`], {
		cwd,
		stdio: 'ignore'
	});
	if (probe.error || probe.status === null || (probe.status !== 0 && probe.status !== 1)) {
		return [`could not check whether release tag ${tag} exists; run inside the repository`];
	}
	if (probe.status === 0) {
		return [`release tag ${tag} already exists; fix forward with a new version`];
	}
	const proposed = parseReleaseVersion(tag.replace(/^v/, ''));
	if (!proposed) return [];
	const listed = spawnSync('git', ['tag', '--list', 'v*'], { cwd, encoding: 'utf8' });
	if (listed.error || listed.status !== 0) {
		return ['could not list existing release tags; run inside the repository'];
	}
	const newest = listed.stdout
		.split('\n')
		.flatMap((existing) => {
			const version = parseReleaseVersion(existing.replace(/^v/, ''));
			return version ? [{ tag: existing, version }] : [];
		})
		.sort((a, b) => compareReleaseVersions(a.version, b.version))
		.at(-1);
	if (newest && compareReleaseVersions(proposed, newest.version) < 0) {
		return [`release tag ${tag} is lower than the newest existing release tag ${newest.tag}`];
	}
	return [];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
	const packageVersion = String(packageJson.version ?? '');
	const args = process.argv.slice(2);
	const tag = args.find((arg) => !arg.startsWith('--')) || process.env.GITHUB_REF_NAME || `v${packageVersion}`;
	const changelog = readFileSync('CHANGELOG.md', 'utf8');
	const errors = validateReleaseTag(tag, packageVersion, changelog);
	if (args.includes('--require-annotated') && !isAnnotatedReleaseTag(tag)) {
		errors.push(`release tag ${tag} must be annotated`);
	}
	if (args.includes('--require-new')) {
		errors.push(...validateNewReleaseTag(tag));
	}
	if (errors.length > 0) {
		for (const error of errors) console.error(`release validation: ${error}`);
		process.exitCode = 1;
	} else {
		console.log(`release validation passed for ${tag}`);
	}
}
