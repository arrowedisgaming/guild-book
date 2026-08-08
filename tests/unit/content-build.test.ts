import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

const PACK_DIR = 'static/content-packs/hmtw';
const packFiles = () => readdirSync(PACK_DIR).filter((f) => f.endsWith('.json'));

const index = JSON.parse(readFileSync(`${PACK_DIR}/index.json`, 'utf8'));

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
		expect(index.files.rulesSearch).toBe('rules-search.json');
	});

	/**
	 * Rule ids are documented as permanent URLs. Once shipped, an id must keep
	 * resolving forever — as a live entry id, or as an alias on the entry that
	 * absorbed it. Add to this list whenever an import retires or renames an
	 * id; never remove from it.
	 */
	it('keeps every shipped rule id resolvable (permanent URLs)', () => {
		const rules = JSON.parse(readFileSync('static/content-packs/hmtw/rules.json', 'utf8'));
		const resolvable = new Set(rules.flatMap((r: { id: string; aliases?: string[] }) => [r.id, ...(r.aliases ?? [])]));
		for (const shipped of ['adventurer-war-pigs', 'challenge-phase-tracking-enemy-damage']) {
			expect(resolvable, `retired/renamed id "${shipped}" must stay resolvable`).toContain(shipped);
		}
	});

	/**
	 * Licensing invariant, enforced on the committed artifacts themselves: the
	 * book's interior art is not covered by the text's open-content permission,
	 * so no image-embed syntax may ship in any pack file. The importer-side
	 * guards (assertNoImageEmbeds) enforce this at build time, but only on a
	 * machine with the vault; this scan runs anywhere — CI without the vault,
	 * and against hand-edited packs a build never touched.
	 */
	it('ships no image-embed syntax in any committed pack file', () => {
		for (const file of packFiles()) {
			expect(readFileSync(`${PACK_DIR}/${file}`, 'utf8'), `${file} contains "!["`).not.toContain('![');
		}
	});

	/**
	 * The app's renderer converts `*` emphasis only, so an `_underscore_` span
	 * that survives import prints its underscores verbatim on the page. Runs
	 * of 3+ underscores are exempt — the guild charter's fill-in blank
	 * ("the Guild, named: __________") is legitimate book text.
	 */
	it('ships no underscore emphasis in any committed pack file', () => {
		for (const file of packFiles()) {
			const offenders: string[] = [];
			JSON.parse(readFileSync(`${PACK_DIR}/${file}`, 'utf8'), (key, value) => {
				for (const s of typeof value === 'string' ? [key, value] : [key]) {
					if (s.replace(/_{3,}/g, '').includes('_')) offenders.push(s.slice(0, 80));
				}
				return value;
			});
			expect(offenders, `${file}: underscore outside a fill-in blank`).toEqual([]);
		}
	});
});
