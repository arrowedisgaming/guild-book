/**
 * `resolveLookup` — the pure oracle-table resolver (Increment 4 Task 4 Step 3).
 *
 * A step carrying a `lookupTableId` resolves its drawn card(s) against the
 * verbatim table Increment 0b generated into the content pack, and the resolved
 * cell text is what the public event carries — the app supplies the rule text;
 * the GM adjudicates the fictional consequence (spec §8.6). Three axes exist
 * and this resolver handles all three; do not assume one card yields one cell.
 *
 * ## Rejection discipline
 *
 * - A card matching zero rows or more than one row is a CONTENT bug, not a
 *   runtime condition: Increment 0b's coverage test makes it unreachable for
 *   every real deck card, so it rejects `content-mismatch` rather than
 *   guessing. (The one deck card with no entry on any oracle table is the
 *   Fool, value 0 — deliberately so, it is the deck's reset card. Callers
 *   handle a Fool draw BEFORE resolving; see the finite runner.)
 * - A token whose source is absent — `[value]` with an empty minor discard —
 *   is a runtime state condition and rejects `illegal-command`, rather than
 *   rendering a literal `[value]` to the table.
 *
 * Pure — no UI/DB/network imports (see
 * `tests/unit/session/import-boundaries.test.ts`).
 */

import type { TarotLookupCell, TarotLookupKeyRange, TarotLookupRow, TarotLookupTable, TarotLookupToken, TarotLookupReference } from '$lib/types/content-pack';
import type { SessionRejection } from '$lib/types/session';
import type { DrawnCard } from '$lib/tarot/protocol';

export interface LookupTableState {
	/** The top card of the minor arcana discard pile — Ch9's bracket
	 * convention: every live token refers to it. `null` when the pile is
	 * empty. */
	minorDiscardTop: DrawnCard | null;
	/**
	 * The live roster count. No token kind in the frozen Increment 0b
	 * vocabulary (`TarotLookupToken`: value/parity/suit/range) consumes it
	 * today — the plan named an `[adventurers]` token, but the generator found
	 * no cell that needed one, so the kind was never minted. Kept in the
	 * signature per the plan so a future pack that grows the vocabulary has
	 * the input already plumbed.
	 */
	adventurerCount: number;
}

export interface ResolvedCell {
	columnId: string;
	/** Verbatim cell text, exactly as extracted from the book. */
	text: string;
	/** `text` with every `[value]` token substituted with the resolved number.
	 * Branch tokens are NOT rewritten — the text stays the book's verbatim
	 * wording; the branches that apply are named in `activeBranches`. */
	resolvedText: string;
	/** The bracket labels among this cell's branch tokens that match the minor
	 * discard top: `'even'`, `'odd'`, a suit label (`'Swords'`), or a value
	 * range (`'3-8'`). Empty for a cell with no branch tokens. */
	activeBranches: string[];
	/** Cross-references to Appendix C denizens, Appendix B alchemy, and rules
	 * entries — rendered as links to existing content entries, never inlined. */
	references: TarotLookupReference[];
}

export type ResolveLookupResult = { ok: true; cells: ResolvedCell[] } | { ok: false; rejection: SessionRejection };

function reject(code: SessionRejection['code'], message: string): ResolveLookupResult {
	return { ok: false, rejection: { code, message } };
}

// ---------------------------------------------------------------------------
// Ordinals — the source's own numerals
// ---------------------------------------------------------------------------

/** Court-card ordinals (minor ranks 11–14). `ace` accepted defensively — the
 * pack's rank labels call rank i "Ace". */
const COURT_ORDINALS: Record<string, number> = { ace: 1, page: 11, knight: 12, queen: 13, king: 14 };

const ROMAN_VALUES: Record<string, number> = { i: 1, v: 5, x: 10 };

function romanToInt(spelling: string): number | null {
	let total = 0;
	let previous = 0;
	for (const char of spelling.toLowerCase().split('').reverse()) {
		const value = ROMAN_VALUES[char];
		if (value === undefined) return null;
		total += value < previous ? -value : value;
		previous = Math.max(previous, value);
	}
	return total;
}

/**
 * Parses a key/token endpoint into an ordinal. The source uses three spellings
 * and this accepts exactly those: roman numerals (`I`–`XXI`), court names
 * (`Page`/`Knight`/`Queen`/`King`), and decimal digits (`1`–`14`, used only
 * inside bracket-token ranges like `[9-King]`).
 */
export function parseOrdinal(spelling: string): number | null {
	const trimmed = spelling.trim();
	if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
	const court = COURT_ORDINALS[trimmed.toLowerCase()];
	if (court !== undefined) return court;
	return romanToInt(trimmed);
}

/** A card's ordinal on the source's own axis: a minor's rank numeric (1–14),
 * a major's number (1–21). The Fool is 0 and matches nothing — deliberately. */
function cardOrdinal(card: DrawnCard): number {
	return card.value;
}

function rangeContains(key: TarotLookupKeyRange, ordinal: number): boolean | null {
	const from = parseOrdinal(key.from);
	const to = parseOrdinal(key.to);
	if (from === null || to === null) return null;
	return ordinal >= from && ordinal <= to;
}

// ---------------------------------------------------------------------------
// Row selection per axis
// ---------------------------------------------------------------------------

function rowsMatchingOrdinal(table: TarotLookupTable, ordinal: number): TarotLookupRow[] | null {
	const matches: TarotLookupRow[] = [];
	for (const row of table.rows) {
		if (row.key.kind !== 'card-range') return null;
		const contained = rangeContains(row.key, ordinal);
		if (contained === null) return null;
		if (contained) matches.push(row);
	}
	return matches;
}

function rowMatchingSuit(table: TarotLookupTable, suit: string): TarotLookupRow | undefined {
	return table.rows.find((row) => row.key.kind === 'suit' && row.key.suit === suit);
}

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

/** The bracket label a token appears under in the verbatim text — `[even]`,
 * `[Swords]`, `[3-8]`. Suit labels are capitalized exactly as the source
 * writes them. */
function branchLabel(token: TarotLookupToken): string {
	switch (token.kind) {
		case 'value':
			return 'value';
		case 'parity':
			return token.parity;
		case 'suit':
			return token.suit.charAt(0).toUpperCase() + token.suit.slice(1);
		case 'range':
			return `${token.from}-${token.to}`;
	}
}

function resolveCellTokens(
	cell: TarotLookupCell,
	tableState: LookupTableState
): { ok: true; resolvedText: string; activeBranches: string[] } | { ok: false; rejection: SessionRejection } {
	if (cell.tokens.length === 0) return { ok: true, resolvedText: cell.text, activeBranches: [] };

	const top = tableState.minorDiscardTop;
	if (!top) {
		// Ch9 defines every token against the top of the minor discard; with the
		// pile empty there is nothing to resolve against, and a literal
		// "[value]" must never reach the table.
		return {
			ok: false,
			rejection: {
				code: 'illegal-command',
				message: 'this result reads the top of the minor arcana discard pile, which is empty — discard a minor card first'
			}
		};
	}

	let resolvedText = cell.text;
	const activeBranches: string[] = [];

	for (const token of cell.tokens) {
		switch (token.kind) {
			case 'value':
				resolvedText = resolvedText.split('[value]').join(String(top.value));
				break;
			case 'parity':
				if (top.value % 2 === (token.parity === 'even' ? 0 : 1)) activeBranches.push(branchLabel(token));
				break;
			case 'suit':
				if (top.suit === token.suit) activeBranches.push(branchLabel(token));
				break;
			case 'range': {
				const from = parseOrdinal(token.from);
				const to = parseOrdinal(token.to);
				/* v8 ignore start -- unparseable token endpoints are a content bug
				 * Increment 0b's own schema test prevents; kept to fail closed. */
				if (from === null || to === null) {
					return { ok: false, rejection: { code: 'content-mismatch', message: `unparseable token range [${token.from}-${token.to}]` } };
				}
				/* v8 ignore stop */
				if (top.value >= from && top.value <= to) activeBranches.push(branchLabel(token));
				break;
			}
		}
	}

	return { ok: true, resolvedText, activeBranches };
}

function resolveCells(cells: TarotLookupCell[], tableState: LookupTableState): ResolveLookupResult {
	const resolved: ResolvedCell[] = [];
	for (const cell of cells) {
		const tokens = resolveCellTokens(cell, tableState);
		if (!tokens.ok) return tokens;
		resolved.push({
			columnId: cell.columnId,
			text: cell.text,
			resolvedText: tokens.resolvedText,
			activeBranches: tokens.activeBranches,
			references: cell.references
		});
	}
	return { ok: true, cells: resolved };
}

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

/**
 * Resolves `draws` against `table` per its axis, then resolves the matched
 * cells' tokens against `tableState`. See the module header for the rejection
 * discipline.
 */
export function resolveLookup(table: TarotLookupTable, draws: DrawnCard[], tableState: LookupTableState): ResolveLookupResult {
	switch (table.axis) {
		case 'card': {
			if (draws.length !== 1) {
				return reject('content-mismatch', `table ${table.id} resolves exactly one card, received ${draws.length}`);
			}
			const ordinal = cardOrdinal(draws[0]);
			const rows = rowsMatchingOrdinal(table, ordinal);
			if (rows === null) return reject('content-mismatch', `table ${table.id} has a non-card-range row on the card axis`);
			if (rows.length !== 1) {
				return reject(
					'content-mismatch',
					`table ${table.id} matches ${rows.length} rows for ${draws[0].label} — a card must match exactly one`
				);
			}
			return resolveCells(rows[0].cells, tableState);
		}

		case 'card-by-suit': {
			if (draws.length !== 1) {
				return reject('content-mismatch', `table ${table.id} resolves exactly one card, received ${draws.length}`);
			}
			const draw = draws[0];
			if (!draw.suit) {
				return reject('content-mismatch', `table ${table.id} selects its column by suit and ${draw.label} has none`);
			}
			const rows = rowsMatchingOrdinal(table, cardOrdinal(draw));
			if (rows === null) return reject('content-mismatch', `table ${table.id} has a non-card-range row on the card-by-suit axis`);
			if (rows.length !== 1) {
				return reject(
					'content-mismatch',
					`table ${table.id} matches ${rows.length} rows for ${draw.label} — a card must match exactly one`
				);
			}
			const cell = rows[0].cells.find((candidate) => candidate.columnId === draw.suit);
			if (!cell) return reject('content-mismatch', `table ${table.id} has no ${draw.suit} column for ${draw.label}'s row`);
			return resolveCells([cell], tableState);
		}

		case 'suit-by-step': {
			if (draws.length !== table.columns.length) {
				return reject(
					'content-mismatch',
					`table ${table.id} reads ${table.columns.length} draws left to right, received ${draws.length}`
				);
			}
			const cells: TarotLookupCell[] = [];
			for (let index = 0; index < draws.length; index += 1) {
				const draw = draws[index];
				if (!draw.suit) {
					return reject('content-mismatch', `table ${table.id} selects rows by suit and ${draw.label} has none`);
				}
				const row = rowMatchingSuit(table, draw.suit);
				if (!row) return reject('content-mismatch', `table ${table.id} has no ${draw.suit} row`);
				const columnId = table.columns[index].id;
				const cell = row.cells.find((candidate) => candidate.columnId === columnId);
				if (!cell) return reject('content-mismatch', `table ${table.id}'s ${draw.suit} row has no ${columnId} cell`);
				cells.push(cell);
			}
			return resolveCells(cells, tableState);
		}
	}
}
