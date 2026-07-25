/**
 * Increment 4 Task 4 Step 3 — `resolveLookup`, the pure oracle-table resolver.
 *
 * Every table asserted against here is the REAL generated content from
 * Increment 0b — a fabricated fixture table would prove the resolver agrees
 * with itself, not with the book. The three axes the source actually uses:
 *
 * - `card` — one draw selects the single row whose range key contains the
 *   card's numeral (We're Doomed keys `I–VII` as ONE row).
 * - `card-by-suit` — one draw selects the row by rank and the column by suit
 *   (Random Totem's 14×4 grid).
 * - `suit-by-step` — N draws, each selecting a row by its suit; step *i* reads
 *   column *i* (Doomsaying's four draws, read left to right).
 *
 * Tokens resolve against live public table state (Ch9's bracket convention:
 * they refer to the top card of the minor arcana discard pile). An absent
 * source rejects rather than rendering a literal `[value]` to the table.
 */

import { describe, expect, it } from 'vitest';
import { getTarotProcedures } from '$lib/server/content/loader';
import { resolveLookup } from '$lib/engine/session/lookup';
import type { TarotLookupTable } from '$lib/types/content-pack';
import type { DrawnCard } from '$lib/tarot/protocol';

const TABLES = getTarotProcedures().lookupTables;

function table(id: string): TarotLookupTable {
	const found = TABLES.find((candidate) => candidate.id === id);
	if (!found) throw new Error(`content pack is missing lookup table ${id}`);
	return found;
}

function minor(value: number, suit: DrawnCard['suit'], id = `test-${suit}-${value}`): DrawnCard {
	return { id, kind: 'minor', label: id, value, suit };
}

function major(value: number, id = `major-${value}`): DrawnCard {
	return { id, kind: 'major', label: id, value };
}

const NO_STATE = { minorDiscardTop: null, adventurerCount: 4 };

function unwrapCells(result: ReturnType<typeof resolveLookup>) {
	if (!result.ok) throw new Error(`expected ok, got ${result.rejection.code}: ${result.rejection.message}`);
	return result.cells;
}

describe('resolveLookup — card axis', () => {
	it('resolves a single-card row (Meatgrinder XVI is a random encounter)', () => {
		const cells = unwrapCells(resolveLookup(table('meatgrinder'), [major(16)], NO_STATE));

		expect(cells).toHaveLength(1);
		expect(cells[0].text).toContain('[Random encounter] Red Herring Tavern');
	});

	it('resolves a RANGE row as one row (We’re Doomed I–VII is one grue)', () => {
		// Every card from I to VII lands the same row — the range is a single
		// row in the source, never expanded into seven.
		for (const value of [1, 4, 7]) {
			const cells = unwrapCells(resolveLookup(table('were-doomed'), [minor(value, 'cups')], NO_STATE));
			expect(cells[0].text).toBe('You are eaten by a grue.');
		}
	});

	it('resolves court-card keys (We’re Doomed Page)', () => {
		const cells = unwrapCells(resolveLookup(table('were-doomed'), [minor(11, 'swords')], NO_STATE));

		expect(cells[0].text).toContain('You make it back to the surface');
	});

	it('carries the row’s cross-references as typed links, never inline text', () => {
		// We're Doomed IX cites the Deeds and Fame rule.
		const cells = unwrapCells(resolveLookup(table('were-doomed'), [minor(9, 'wands')], NO_STATE));

		expect(cells[0].references).toContainEqual(
			expect.objectContaining({ collection: 'rules', entryId: 'guild-deeds-and-fame' })
		);
	});

	it('rejects a card matching no row as content-mismatch (the Fool has no oracle entry)', () => {
		const fool: DrawnCard = { id: 'fool', kind: 'major', label: 'The Fool', value: 0 };

		expect(resolveLookup(table('meatgrinder'), [fool], NO_STATE)).toMatchObject({
			ok: false,
			rejection: { code: 'content-mismatch' }
		});
	});

	it('rejects the wrong number of draws for the axis', () => {
		expect(resolveLookup(table('meatgrinder'), [major(3), major(4)], NO_STATE)).toMatchObject({
			ok: false,
			rejection: { code: 'content-mismatch' }
		});
		expect(resolveLookup(table('meatgrinder'), [], NO_STATE)).toMatchObject({
			ok: false,
			rejection: { code: 'content-mismatch' }
		});
	});
});

describe('resolveLookup — card-by-suit axis', () => {
	it('selects the row by rank and the column by suit (Random Totem III of Wands)', () => {
		const cells = unwrapCells(resolveLookup(table('random-totem'), [minor(3, 'wands')], NO_STATE));

		expect(cells).toHaveLength(1);
		expect(cells[0]).toMatchObject({ columnId: 'wands', text: 'Centipede, Dire' });
	});

	it('the same rank yields a different totem per suit', () => {
		const bySuit = (suit: DrawnCard['suit']) =>
			unwrapCells(resolveLookup(table('random-totem'), [minor(5, suit)], NO_STATE))[0].text;

		expect(bySuit('swords')).toBe('Bear');
		expect(bySuit('cups')).toBe('Raccoon');
		expect(bySuit('pentacles')).toBe('Hyena');
		expect(bySuit('wands')).toBe('Grasshopper, Dire');
	});

	it('rejects a suitless card — a major cannot address a suit column', () => {
		expect(resolveLookup(table('random-totem'), [major(3)], NO_STATE)).toMatchObject({
			ok: false,
			rejection: { code: 'content-mismatch' }
		});
	});
});

describe('resolveLookup — suit-by-step axis', () => {
	it('reads Doomsaying’s four draws left to right, each row by its suit', () => {
		const draws = [minor(2, 'swords'), minor(9, 'pentacles'), minor(4, 'cups'), minor(12, 'wands')];

		const cells = unwrapCells(resolveLookup(table('doomsaying'), draws, NO_STATE));

		expect(cells.map((cell) => cell.columnId)).toEqual(['step-1', 'step-2', 'step-3', 'step-4']);
		expect(cells[0].text).toContain('Constellation of the Beast');
		expect(cells[1].text).toContain('the Last Queen will blind herself');
		expect(cells[2].text).toContain('A new star is kindled');
		expect(cells[3].text).toContain('the Clarion of Altheia');
	});

	it('the same suits in a different order tell a different prophecy', () => {
		const forward = unwrapCells(
			resolveLookup(table('doomsaying'), [minor(2, 'swords'), minor(3, 'cups'), minor(4, 'swords'), minor(5, 'cups')], NO_STATE)
		);
		const reversed = unwrapCells(
			resolveLookup(table('doomsaying'), [minor(2, 'cups'), minor(3, 'swords'), minor(4, 'cups'), minor(5, 'swords')], NO_STATE)
		);

		expect(forward.map((cell) => cell.text)).not.toEqual(reversed.map((cell) => cell.text));
	});

	it('rejects fewer draws than the table has steps', () => {
		expect(resolveLookup(table('doomsaying'), [minor(2, 'swords')], NO_STATE)).toMatchObject({
			ok: false,
			rejection: { code: 'content-mismatch' }
		});
	});
});

describe('resolveLookup — tokens (Ch9’s bracket convention)', () => {
	it('substitutes [value] from the minor discard top (Hangover I)', () => {
		const result = resolveLookup(table('hangover'), [major(1)], {
			minorDiscardTop: minor(7, 'cups'),
			adventurerCount: 4
		});

		const cells = unwrapCells(result);
		expect(cells[0].resolvedText).toContain('7 new gold coins');
		expect(cells[0].resolvedText).not.toContain('[value]');
	});

	it('rejects a [value] token when the minor discard is empty', () => {
		// Rendering a literal "[value]" to the table is exactly what the
		// amendment forbids; an empty discard means the token has no source.
		expect(resolveLookup(table('hangover'), [major(1)], NO_STATE)).toMatchObject({
			ok: false,
			rejection: { code: 'illegal-command' }
		});
	});

	it('resolves parity branches from the discard top (Hangover VII)', () => {
		const even = unwrapCells(
			resolveLookup(table('hangover'), [major(7)], { minorDiscardTop: minor(4, 'cups'), adventurerCount: 4 })
		);
		const odd = unwrapCells(
			resolveLookup(table('hangover'), [major(7)], { minorDiscardTop: minor(5, 'cups'), adventurerCount: 4 })
		);

		expect(even[0].activeBranches).toEqual(['even']);
		expect(odd[0].activeBranches).toEqual(['odd']);
	});

	it('resolves suit and value-range branches together (Hangover IX)', () => {
		const cells = unwrapCells(
			resolveLookup(table('hangover'), [major(9)], { minorDiscardTop: minor(6, 'pentacles'), adventurerCount: 4 })
		);

		// The tattoo is on the leg ([Pentacles]) and its subject comes from the
		// 3–8 band ([3-8]).
		expect(cells[0].activeBranches).toEqual(expect.arrayContaining(['Pentacles', '3-8']));
		expect(cells[0].activeBranches).not.toEqual(expect.arrayContaining(['Swords', '1-2', '9-King']));
	});

	it('resolves a court card in a token range by its ordinal (9–King)', () => {
		const cells = unwrapCells(
			resolveLookup(table('hangover'), [major(9)], { minorDiscardTop: minor(13, 'swords'), adventurerCount: 4 })
		);

		expect(cells[0].activeBranches).toEqual(expect.arrayContaining(['Swords', '9-King']));
	});

	it('a cell with no tokens resolves with untouched text and no branches', () => {
		const cells = unwrapCells(resolveLookup(table('meatgrinder'), [major(16)], NO_STATE));

		expect(cells[0].resolvedText).toBe(cells[0].text);
		expect(cells[0].activeBranches).toEqual([]);
	});
});
