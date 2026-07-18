/**
 * Compiles the immutable, digest-stamped `SessionRuntimeContentV1` document
 * every live session pins at start (see `sessionRuntimeContents` in
 * `$lib/server/db/schema.ts`). A mid-campaign content-pack update must never
 * change a live session's rules — so once compiled and persisted, this
 * document is the only source of truth the command service (Task 5) reads
 * from; the bundled content pack is never consulted again for that session.
 *
 * Server-side only (imports the content-pack loader and Node's `crypto` via
 * `canonical-json.ts`). Compilation is deterministic: identical inputs
 * produce a deeply-equal document and an identical `contentDigest`.
 */

import type { GuildBookContentPack, TarotConfig, TarotProceduresFile } from '$lib/types/content-pack';
import type { SessionRuntimeContentV1, TarotCardCatalog, TarotCardCatalogEntry } from '$lib/types/session';
import type { SessionEngineRuntime } from '$lib/engine/session/reducer';
import { getContentPack, getTarotProcedures } from './loader';
import { buildMajorDeck, buildPlayerDeck, type TarotCard } from '$lib/engine/tarot-deck';
import { canonicalDigest } from './canonical-json';
import { parseSessionRuntimeContentOrThrow } from '$lib/schemas/session-runtime.schema';

/** D1 row-size headroom (controller amendment 6). A compiled document at or
 * above this size is a bug (speculative/duplicated data), not a case to
 * silently truncate. */
export const MAX_SESSION_RUNTIME_CONTENT_BYTES = 1_900_000;

function toCatalogEntry(card: TarotCard, deck: 'major' | 'player'): TarotCardCatalogEntry {
	if (card.kind === 'major') {
		return {
			id: card.id,
			deck,
			label: card.name,
			imageKey: card.id,
			value: card.value,
			major: { number: card.number, name: card.name, doomTier: card.doomTier, valueParity: card.valueParity }
		};
	}
	return {
		id: card.id,
		deck,
		label: card.label,
		imageKey: card.id,
		value: card.value,
		suit: card.suit,
		rank: card.rank
	};
}

/** All 78 configured cards (21 majors + 56 minors + the Fool), each hydrated
 * with the label/value/suit-or-major metadata `src/lib/engine/tarot-deck.ts`
 * already derives from the content pack's `TarotConfig` — no fields beyond
 * what that module (and therefore real content) already produces. */
export function buildCardCatalogEntries(tarot: TarotConfig): TarotCardCatalogEntry[] {
	const entries: TarotCardCatalogEntry[] = [];
	for (const card of buildMajorDeck(tarot)) entries.push(toCatalogEntry(card, 'major'));
	for (const card of buildPlayerDeck(tarot)) entries.push(toCatalogEntry(card, 'player'));
	return entries;
}

export interface CompileSessionRuntimeContentInput {
	/** Defaults to the bundled `getContentPack()`. Overridable so tests (and
	 * a future re-compile-for-diffing tool) can compile against a specific
	 * pack snapshot without touching the loader's module-level cache. */
	pack?: GuildBookContentPack;
	/** Defaults to the bundled `getTarotProcedures()`. */
	proceduresFile?: TarotProceduresFile;
}

/**
 * Compiles the pinned runtime document from the (bundled, or supplied)
 * content pack. Validates the result against `sessionRuntimeContentV1Schema`
 * and the size bound before returning — the same validation
 * `parseSessionRuntimeContent` applies when re-parsing a persisted row after
 * read, so both directions go through one gate.
 */
export function compileSessionRuntimeContent(
	input: CompileSessionRuntimeContentInput = {}
): SessionRuntimeContentV1 {
	const pack = input.pack ?? getContentPack();
	const proceduresFile = input.proceduresFile ?? getTarotProcedures();

	const unsigned = {
		schemaVersion: 1 as const,
		contentPackId: pack.id,
		contentPackVersion: pack.version,
		tarot: pack.tarot,
		procedures: proceduresFile.procedures,
		cards: buildCardCatalogEntries(pack.tarot),
		modifiers: proceduresFile.modifiers,
		// Taken whole, no subsetting filter: Increment 0b already generated
		// `lookupTables`/`formulas` scoped to the same procedure set as
		// `procedures`/`modifiers` (spec §6.4 — normative over the plan's
		// original Step 2 shape).
		lookupTables: proceduresFile.lookupTables,
		formulas: proceduresFile.formulas
	};

	const contentDigest = canonicalDigest(unsigned);
	return parseSessionRuntimeContent({ ...unsigned, contentDigest });
}

/**
 * Validates `value` (typically `JSON.parse`d out of `session_runtime_contents
 * .runtime_content_json`) against `sessionRuntimeContentV1Schema` and the
 * size bound, throwing on either failure. Used both right after compilation
 * (pre-insert) and every time a persisted snapshot is read back — one gate,
 * two call sites, so a malformed or bloated document can never reach or
 * leave storage unnoticed.
 */
export function parseSessionRuntimeContent(value: unknown): SessionRuntimeContentV1 {
	const parsed = parseSessionRuntimeContentOrThrow(value) as SessionRuntimeContentV1;
	const byteLength = new TextEncoder().encode(JSON.stringify(parsed)).byteLength;
	if (byteLength >= MAX_SESSION_RUNTIME_CONTENT_BYTES) {
		throw new Error(
			`session runtime content is ${byteLength} bytes, at or above the ${MAX_SESSION_RUNTIME_CONTENT_BYTES}-byte bound`
		);
	}
	return parsed;
}

/** `TarotCardCatalog` (the `Record<CardId, entry>` the pure engine indexes
 * by id) built from the compiled document's `cards` array. */
export function toCardCatalog(cards: readonly TarotCardCatalogEntry[]): TarotCardCatalog {
	const catalog: TarotCardCatalog = {};
	for (const card of cards) catalog[card.id] = card;
	return catalog;
}

/**
 * Adapts a compiled/persisted `SessionRuntimeContentV1` into the engine's
 * `ReduceContext.runtime` shape (`SessionEngineRuntime`, currently just
 * `{ catalog }` — see `$lib/engine/session/reducer.ts`). Structural, not a
 * weakening of the engine's purity: this function lives in server code and
 * the engine still only ever sees the plain `TarotCardCatalog` it already
 * expected.
 */
export function toSessionEngineRuntime(content: SessionRuntimeContentV1): SessionEngineRuntime {
	return { catalog: toCardCatalog(content.cards) };
}
