/**
 * Language list helpers for the adventurer sheet.
 *
 * Languages are stored on the character as plain display strings, not content
 * ids: the sheet, the share page, and the PDF export all render
 * `char.languages` verbatim, and a language typed in by hand has no id to
 * store. Picking "Vulgaris" from the pack therefore stores the same thing a
 * player would have typed, and the two kinds stay interchangeable.
 *
 * Everything here is pure so the editor's rules can be unit-tested without
 * rendering the component.
 */

import type { NamedEntry } from '$lib/types/content-pack';

/** Guards a single stored entry against runaway paste input. */
export const MAX_LANGUAGE_LENGTH = 60;

/** Collapses interior whitespace so " old  vetus " and "old vetus" match. */
export function normalizeLanguage(value: string): string {
	return value.replace(/\s+/g, ' ').trim().slice(0, MAX_LANGUAGE_LENGTH);
}

/** Case-insensitive match key — "Cant" and "cant" are the same tongue. */
function key(value: string): string {
	return normalizeLanguage(value).toLocaleLowerCase();
}

/** True when `value` is already in the list, ignoring case and stray spaces. */
export function knowsLanguage(known: readonly string[], value: string): boolean {
	const wanted = key(value);
	return wanted !== '' && known.some((entry) => key(entry) === wanted);
}

/** Pack languages the adventurer has not learned yet, in pack order. */
export function availableLanguages(
	known: readonly string[],
	catalog: readonly NamedEntry[]
): NamedEntry[] {
	return catalog.filter((entry) => !knowsLanguage(known, entry.name));
}

/**
 * Returns the list with `value` appended, or the ORIGINAL array when the value
 * is blank or already known — callers compare identity to decide whether the
 * add was a no-op worth reporting.
 */
export function addLanguage(known: readonly string[], value: string): string[] {
	const next = normalizeLanguage(value);
	if (!next || knowsLanguage(known, next)) return known as string[];
	return [...known, next];
}

/** Drops the entry at `index`; an out-of-range index leaves the list alone. */
export function removeLanguageAt(known: readonly string[], index: number): string[] {
	if (index < 0 || index >= known.length) return known as string[];
	return known.filter((_, i) => i !== index);
}
