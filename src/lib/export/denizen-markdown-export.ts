/**
 * Export a dungeon denizen to Obsidian-flavored Markdown with YAML frontmatter.
 * Pure — a DenizenDefinition in, a Markdown string out.
 */

import type { DenizenDefinition, DenizenAbility, DenizenStatValue } from '$lib/types/content-pack';
import { abilityLabel } from '$lib/utils/ability-label';

function yamlValue(v: string): string {
	// Quote values that could confuse a YAML parser.
	return /[:#\-?&*!|>'"%@`]/.test(v) || v === '' ? JSON.stringify(v) : v;
}

/** Stats may be numbers or book-special strings ("∞", "X") — encode both safely. */
function yamlStat(v: DenizenStatValue): string {
	return typeof v === 'number' ? String(v) : yamlValue(v);
}

function abilitySection(title: string, list: DenizenAbility[] | undefined): string[] {
	if (!list?.length) return [];
	return [`#### ${title}`, '', ...list.map((a) => `- **${abilityLabel(a.name)}** ${a.text}`), ''];
}

export function exportDenizenToMarkdown(
	denizen: DenizenDefinition,
	themeName: string,
	threatName: string
): string {
	const frontmatter = [
		'---',
		`name: ${yamlValue(denizen.name)}`,
		'system: His Majesty the Worm',
		`theme: ${yamlValue(themeName)}`,
		`threat: ${yamlValue(threatName)}`,
		`swords: ${yamlStat(denizen.attributes.swords)}`,
		`pentacles: ${yamlStat(denizen.attributes.pentacles)}`,
		`cups: ${yamlStat(denizen.attributes.cups)}`,
		`wands: ${yamlStat(denizen.attributes.wands)}`,
		denizen.health !== undefined && denizen.defense !== undefined
			? `hd: ${yamlValue(`${denizen.health}/${denizen.defense}`)}`
			: null,
		'tags: [hmtw, denizen]',
		'---'
	].filter((line): line is string => line !== null);

	const lines: string[] = [
		...frontmatter,
		'',
		`## ${denizen.name}`,
		'',
		`_${themeName} ${threatName}_`,
		'',
		...denizen.flavor.split('\n\n').flatMap((p) => [`_${p.replace(/\n/g, ' ')}_`, '']),
		`**Attributes:** Swords ${denizen.attributes.swords} | Pentacles ${denizen.attributes.pentacles} | Cups ${denizen.attributes.cups} | Wands ${denizen.attributes.wands}`,
		''
	];

	if (denizen.health !== undefined && denizen.defense !== undefined) {
		lines.push(`**Health/Defense:** ${denizen.health}/${denizen.defense}`, '');
	}
	if (denizen.statNote) lines.push(`_${denizen.statNote}_`, '');
	if (denizen.likes?.length) lines.push(`**Likes:** ${denizen.likes.join(', ')}`, '');
	if (denizen.hates?.length) lines.push(`**Hates:** ${denizen.hates.join(', ')}`, '');

	if (denizen.specialRules) {
		lines.push('#### Special rules', '', denizen.specialRules, '');
	}

	lines.push(
		...abilitySection('Notes', denizen.notes),
		...abilitySection('Lesser dooms', denizen.lesserDooms),
		...abilitySection('Greater dooms', denizen.greaterDooms)
	);

	for (const pool of denizen.pools ?? []) {
		// A pool may omit its HD pair, and builder drafts can hold an incomplete
		// pair — omit HD rather than render "3/", "/", or "undefined/undefined".
		const poolHd =
			pool.health !== undefined && pool.defense !== undefined
				? ` — Health/Defense: ${pool.health}/${pool.defense}`
				: '';
		lines.push(`### ${pool.name}${poolHd}`, '');
		if (pool.text) lines.push(pool.text, '');
		lines.push(
			...abilitySection('Notes', pool.notes),
			...abilitySection('Lesser dooms', pool.lesserDooms),
			...abilitySection('Greater dooms', pool.greaterDooms)
		);
	}

	for (const sidebar of denizen.sidebars ?? []) {
		lines.push(
			`> [!sidebar] ${sidebar.title}`,
			...sidebar.body.split('\n').map((l) => `> ${l}`),
			''
		);
	}

	return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
