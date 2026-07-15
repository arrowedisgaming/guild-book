import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { MD_DIR, extractTable, parseCardKey } from '../../scripts/content-import/md-lib.mjs';

/**
 * Oracle-table extraction. This is a separate path from `extractRuleBody`
 * because the rules reference deliberately (a) drops the `Example …`
 * sub-sections that the two biggest tables live under and (b) flattens the
 * wikilink cross-references these tables need as data.
 *
 * Skipped where the gitignored Markdown vault is absent (i.e. CI).
 */
describe.skipIf(!existsSync(MD_DIR))('oracle table extraction', () => {
	it('preserves a table the rules path deliberately strips', () => {
		const table = extractTable('06 - Chapter 6 - The Crawl Phase.md', 'Example Meatgrinder table', undefined, {
			deck: 'major'
		});
		expect(table.rows.length).toBeGreaterThan(0);
		expect(table.rows[0].cells[0].text).toContain('Torches gutter');
	});

	it('parses an en-dash range key without splitting it', () => {
		const table = extractTable('06 - Chapter 6 - The Crawl Phase.md', 'We’re doomed!', undefined, {
			deck: 'minor'
		});
		expect(table.rows[0].key).toEqual({ kind: 'card-range', from: 'I', to: 'VII' });
		expect(table.deck).toBe('minor');
		expect(table.axis).toBe('card');
	});

	it('reads suit columns through the img markup', () => {
		const table = extractTable('11 - Appendix A - Sorcery.md', 'Random Totem', undefined, { deck: 'minor' });
		expect(table.columns.map((c: { label: string }) => c.label)).toEqual([
			'Swords',
			'Cups',
			'Pentacles',
			'Wands'
		]);
		expect(table.axis).toBe('card-by-suit');
		expect(table.rows).toHaveLength(14);
		expect(table.rows[0].cells[0].text).toBe('Ape');
	});

	it('reads a suit-by-step grid', () => {
		const table = extractTable('14 - Appendix D - City Creation.md', undefined, undefined, {
			anchor: '- **Doomsaying:**',
			deck: 'minor'
		});
		expect(table.axis).toBe('suit-by-step');
		expect(table.rows).toHaveLength(4);
		expect(table.rows[0].key).toEqual({ kind: 'suit', suit: 'swords' });
		expect(table.columns).toHaveLength(4);
	});

	it('retains wikilink cross-references instead of flattening them', () => {
		const table = extractTable('11 - Appendix A - Sorcery.md', 'Maleficence of the Wastes', undefined, {
			deck: 'minor'
		});
		const first = table.rows[0].cells[0];
		expect(first.references).toContainEqual({
			collection: 'denizens',
			entryId: 'imp',
			label: 'imp'
		});
		// The label survives in the text; the wikilink syntax does not.
		expect(first.text).toContain('imp');
		expect(first.text).not.toContain('[[');
	});

	it('types bracket tokens', () => {
		const table = extractTable('09 - Chapter 9 - The City Phase.md', 'Carouse', undefined, { deck: 'major' });
		const withValue = table.rows.find((r: { cells: { tokens: string[] }[] }) =>
			r.cells[0].tokens.includes('value')
		);
		expect(withValue).toBeDefined();
		expect(table.deck).toBe('major');
	});

	it('emits no HTML in cell text', () => {
		for (const [file, heading, deck] of [
			['11 - Appendix A - Sorcery.md', 'Random Totem', 'minor'],
			['09 - Chapter 9 - The City Phase.md', 'Signs and Portents', 'minor']
		] as const) {
			const table = extractTable(file, heading, undefined, { deck });
			for (const row of table.rows) {
				for (const cell of row.cells) {
					expect(cell.text, `${heading}`).not.toMatch(/<[^>]+>/);
				}
			}
		}
	});
});

describe('parseCardKey', () => {
	it('reads a single numeral as a degenerate range', () => {
		expect(parseCardKey('VIII')).toEqual({ kind: 'card-range', from: 'VIII', to: 'VIII' });
	});

	it('reads an en-dash range', () => {
		expect(parseCardKey('I–VII')).toEqual({ kind: 'card-range', from: 'I', to: 'VII' });
	});

	it('reads a hyphen range', () => {
		expect(parseCardKey('I-II')).toEqual({ kind: 'card-range', from: 'I', to: 'II' });
	});

	it('reads court ranks', () => {
		expect(parseCardKey('Knight')).toEqual({ kind: 'card-range', from: 'Knight', to: 'Knight' });
	});

	it('strips markup before parsing', () => {
		expect(parseCardKey('  **X**  ')).toEqual({ kind: 'card-range', from: 'X', to: 'X' });
	});
});
