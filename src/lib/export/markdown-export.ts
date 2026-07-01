/**
 * Export an adventurer to Obsidian-flavored Markdown with YAML frontmatter.
 * Pure — a resolved CharacterView in, a Markdown string out.
 */

import type { CharacterView } from '$lib/types/character-view';

function yamlValue(v: string): string {
	// Quote values that could confuse a YAML parser.
	return /[:#\-?&*!|>'"%@`]/.test(v) || v === '' ? JSON.stringify(v) : v;
}

export function exportToMarkdown(view: CharacterView): string {
	const attrs = Object.fromEntries(view.attributes.map((a) => [a.id, a.value]));

	const frontmatter = [
		'---',
		`name: ${yamlValue(view.name || 'Unnamed Adventurer')}`,
		'system: His Majesty the Worm',
		view.kith ? `kith: ${yamlValue(view.kith)}` : null,
		view.kin ? `kin: ${yamlValue(view.kin)}` : null,
		view.path ? `path: ${yamlValue(view.path)}` : null,
		`swords: ${attrs.swords ?? 0}`,
		`pentacles: ${attrs.pentacles ?? 0}`,
		`cups: ${attrs.cups ?? 0}`,
		`wands: ${attrs.wands ?? 0}`,
		`resolve: ${view.resolve.current}/${view.resolve.max}`,
		view.motifs.length ? `motifs: [${view.motifs.map(yamlValue).join(', ')}]` : null,
		'tags: [hmtw, adventurer]',
		'---',
		''
	].filter((l) => l !== null);

	const lines: string[] = [...(frontmatter as string[])];
	lines.push(`# ${view.name || 'Unnamed Adventurer'}`, '');

	const ident = [view.kin && view.kith ? `${view.kin} (${view.kith})` : view.kin, view.path]
		.filter(Boolean)
		.join(' · ');
	if (ident) lines.push(`*${ident}*`, '');

	lines.push('## Attributes', '');
	for (const a of view.attributes) lines.push(`- **${a.name}:** ${a.value}`);
	lines.push('');

	if (view.appearance) lines.push('## Appearance', '', view.appearance, '');
	if (view.quest) lines.push('## Quest', '', view.quest, '');
	if (view.motifs.length) lines.push('## Motifs', '', ...view.motifs.map((m) => `- ${m}`), '');
	if (view.talents.length) {
		lines.push('## Talents', '', ...view.talents.map((t) => `- ${t.name} *(${t.state})*`), '');
	}
	if (view.equipment.length) {
		lines.push('## Gear', '', ...view.equipment.map((e) => `- ${e.name} — ${e.tier}`), '');
	}
	if (view.bonds.length) {
		lines.push('## Bonds', '', ...view.bonds.map((b) => `- **${b.targetName}:** ${b.text}`), '');
	}
	if (view.notes) lines.push('## Notes', '', view.notes, '');

	lines.push(
		'',
		'---',
		'*His Majesty the Worm is copyright Joshua McCrowell. Guild Book is an independent production by Arrowed and is not affiliated with Joshua McCrowell or Exalted Funeral.*'
	);

	return lines.join('\n');
}
