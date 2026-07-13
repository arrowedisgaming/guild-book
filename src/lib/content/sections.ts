/**
 * Rules-reference section taxonomy. Sections mirror the core rulebook's chapters
 * (and its game-text appendices). The order here is the book's order — the
 * `/rules` index and the loader both present sections in this sequence.
 *
 * `section` slugs are content-authored strings on each `RuleEntry`, so this
 * list is display metadata, not a schema constraint: an entry whose section is
 * absent here still loads, it just falls to the end with a title-cased label.
 */

export const RULES_SECTIONS = [
	{ id: 'basics', label: 'The Basics' },
	{ id: 'adventurer', label: 'The Adventurer' },
	{ id: 'guild', label: 'The Guild' },
	{ id: 'kith-and-kin', label: 'Kith & Kin' },
	{ id: 'four-paths', label: 'The Four Paths' },
	{ id: 'crawl-phase', label: 'The Crawl Phase' },
	{ id: 'challenge-phase', label: 'The Challenge Phase' },
	{ id: 'camp-phase', label: 'The Camp Phase' },
	{ id: 'city-phase', label: 'The City Phase' },
	{ id: 'gamemastering', label: 'Gamemastering' },
	{ id: 'appendix-sorcery', label: 'Appendix: Sorcery' },
	{ id: 'appendix-alchemy', label: 'Appendix: Alchemy' }
] as const;

export type RulesSectionId = (typeof RULES_SECTIONS)[number]['id'];

const LABEL_BY_ID = new Map<string, string>(RULES_SECTIONS.map((s) => [s.id, s.label]));
const ORDER_BY_ID = new Map<string, number>(RULES_SECTIONS.map((s, i) => [s.id, i]));

/** Human-facing label for a section slug; falls back to a title-cased slug. */
export function sectionLabel(id: string): string {
	return (
		LABEL_BY_ID.get(id) ??
		id
			.split('-')
			.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
			.join(' ')
	);
}

/** Sort key for a section slug in book order; unknown sections sort last (stable). */
export function sectionOrder(id: string): number {
	return ORDER_BY_ID.get(id) ?? RULES_SECTIONS.length;
}
