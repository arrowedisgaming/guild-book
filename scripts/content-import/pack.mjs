// @ts-nocheck — plain ESM build script, not part of the typed app surface.
// `scripts/` is outside tsconfig's `include`, so these were never typechecked; a
// test importing this module would otherwise drag the whole script tree into
// svelte-check under checkJs and report dozens of implicit-any errors.
// Shared paths + JSON field-path helpers for the content-import scripts.
// The whole pack is now sourced from the Markdown vault (assets-src/HMTW_md/);
// the earlier PDF pipeline has been retired.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const ROOT = join(__dirname, '..', '..');
export const PACK_DIR = join(ROOT, 'static', 'content-packs', 'hmtw');
export const MD_DIR = join(ROOT, 'assets-src', 'HMTW_md');

/** Parses a dotted/indexed field path into tokens: object keys (string) and array indices (number or id-string). */
function parseFieldPath(path) {
	const tokens = [];
	for (const part of path.split('.')) {
		const m = /^([^[]+)((?:\[[^\]]+\])*)$/.exec(part);
		if (!m) throw new Error(`bad field path segment: ${part}`);
		tokens.push(m[1]);
		for (const idx of m[2].match(/\[[^\]]+\]/g) || []) {
			const raw = idx.slice(1, -1);
			tokens.push(/^\d+$/.test(raw) ? Number(raw) : raw);
		}
	}
	return tokens;
}

function resolveArrayIndexById(arr, idToken) {
	if (typeof idToken === 'number') return idToken;
	const idx = arr.findIndex((el) => el && el.id === idToken);
	if (idx === -1) throw new Error(`no array element with id ${JSON.stringify(idToken)}`);
	return idx;
}

/** Sets `value` at a dotted/indexed field path (supports `[0]` and `[id]` array addressing). */
export function setByFieldPath(entryObj, fieldPath, value) {
	const tokens = parseFieldPath(fieldPath);
	let cursor = entryObj;
	for (let i = 0; i < tokens.length - 1; i++) {
		const token = tokens[i];
		cursor = Array.isArray(cursor) ? cursor[resolveArrayIndexById(cursor, token)] : cursor[token];
		if (cursor === undefined) throw new Error(`field path ${fieldPath} does not resolve on entry`);
	}
	const last = tokens[tokens.length - 1];
	if (Array.isArray(cursor) && typeof last === 'string' && !/^\d+$/.test(String(last))) {
		cursor[resolveArrayIndexById(cursor, last)] = value;
	} else {
		cursor[last] = value;
	}
}

/** Reads the value at a dotted/indexed field path (mirror of setByFieldPath). */
export function readByFieldPath(entryObj, fieldPath) {
	let cursor = entryObj;
	for (const token of parseFieldPath(fieldPath)) {
		cursor = Array.isArray(cursor) && typeof token === 'string' && !/^\d+$/.test(token)
			? cursor[resolveArrayIndexById(cursor, token)]
			: cursor[token];
	}
	return cursor;
}
