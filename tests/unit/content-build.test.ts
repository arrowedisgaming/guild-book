import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const index = JSON.parse(readFileSync('static/content-packs/hmtw/index.json', 'utf8'));

describe('generated session content', () => {
	/**
	 * A session pins its rules by storing a compiled runtime snapshot in one D1
	 * row, so the generated catalog must stay well inside D1's 2 MB row limit.
	 */
	it('fits within one D1 row with safety margin', () => {
		const bytes = readFileSync('static/content-packs/hmtw/tarot-procedures.json').byteLength;
		expect(bytes).toBeLessThan(1_900_000);
	});

	it('declares the post-import pack version', () => {
		expect(index.version).not.toBe('1.0.0');
	});

	/** CI enforces that a content change bumps the version; the digest is how. */
	it('records a content digest', () => {
		expect(index.contentDigest).toMatch(/^[0-9a-f]{64}$/);
	});

	it('declares every generated file it ships', () => {
		expect(index.files.tarotProcedures).toBe('tarot-procedures.json');
		expect(index.files.rules).toBe('rules.json');
	});
});
