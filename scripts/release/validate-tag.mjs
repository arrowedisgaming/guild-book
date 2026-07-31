import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? '';
	const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
	const changelog = readFileSync('CHANGELOG.md', 'utf8');
	const errors = validateReleaseTag(tag, String(packageJson.version ?? ''), changelog);
	if (errors.length > 0) {
		for (const error of errors) console.error(`release validation: ${error}`);
		process.exitCode = 1;
	} else {
		console.log(`release validation passed for ${tag}`);
	}
}
