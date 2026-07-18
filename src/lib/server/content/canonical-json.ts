/**
 * Deterministic JSON serialization and digesting. Used to compute
 * `SessionRuntimeContentV1.contentDigest` (Task 4) and, per the roadmap, by
 * Task 5's command service to hash `SessionCommandEnvelope` payloads the same
 * stable way — kept in its own module so neither caller reimplements it.
 *
 * "Canonical" here means: object keys are recursively sorted so property
 * insertion order never changes the output; array order is preserved because
 * arrays are semantically ordered data in this codebase (procedure steps,
 * card ids, etc.). Server-only (uses Node's `crypto`) — never import this
 * from `$lib/engine/`.
 */

import { createHash } from 'node:crypto';

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value !== null && typeof value === 'object') {
		const source = value as Record<string, unknown>;
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(source).sort()) {
			sorted[key] = canonicalize(source[key]);
		}
		return sorted;
	}
	return value;
}

/** Stable-key JSON serialization: identical input always yields an identical
 * string, regardless of the object's original key order. */
export function canonicalJsonStringify(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

/** Lowercase hex SHA-256 of a UTF-8 string. */
export function sha256Hex(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** SHA-256 (hex) over `value`'s stable-key canonical serialization. */
export function canonicalDigest(value: unknown): string {
	return sha256Hex(canonicalJsonStringify(value));
}
