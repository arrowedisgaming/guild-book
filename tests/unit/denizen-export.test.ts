import { describe, it, expect } from 'vitest';
import { exportDenizenToMarkdown } from '$lib/export/denizen-markdown-export';
import { buildDenizenDocDefinition } from '$lib/export/denizen-pdf-export';
import {
	createBlankDraft,
	createBlankPoolDraft,
	seedFromTemplates,
	toDenizenDefinition
} from '$lib/engine/denizen-builder';
import { getBestiary, getDenizenThemes, getDenizenThreats } from '$lib/server/content/loader';

const byId = Object.fromEntries(getBestiary().map((d) => [d.id, d]));

const lordDraft = () =>
	seedFromTemplates(
		{ ...createBlankDraft(), name: 'Gilded Horror' },
		getDenizenThemes().find((t) => t.id === 'sorcerous')!,
		getDenizenThreats().find((t) => t.id === 'dungeon-lord')!
	);

/** A built dungeon lord, the way the builder's review step materializes one. */
const builtLord = toDenizenDefinition(lordDraft());

/** A pooled lord mid-edit: one complete pool, one that only has a name so far. */
const pooledLord = toDenizenDefinition({
	...lordDraft(),
	specialRules: 'The horror regrows a defeated pool at dawn.',
	pools: [
		{
			...createBlankPoolDraft(),
			name: 'The Crown',
			health: '6',
			defense: '3',
			text: 'Shattering the crown breaks its dominion.',
			lesserDooms: [{ name: 'Crownfall', text: 'The crown cracks.' }]
		},
		{ ...createBlankPoolDraft(), name: 'The Roots' }
	]
});

describe('denizen markdown export', () => {
	it('produces frontmatter, stat line, and doom sections for a simple creature', () => {
		const md = exportDenizenToMarkdown(byId['skeleton'], 'Undead', 'Brute');
		expect(md).toContain('name: Skeleton');
		expect(md).toContain('## Skeleton');
		expect(md).toContain('_Undead Brute_');
		expect(md).toContain('**Attributes:** Swords 6 | Pentacles 1 | Cups 1 | Wands 4');
		expect(md).toContain('**Health/Defense:** 6/0');
		expect(md).toContain('#### Lesser dooms');
		expect(md).toContain('- **Unearthly Fear.**');
	});

	it('renders dungeon-lord pools as their own sections', () => {
		const md = exportDenizenToMarkdown(byId['lich-yellow-king'], 'Undead', 'Dungeon Lord');
		expect(md).toContain('### Phylactery — Health/Defense: 1/0');
		expect(md).toContain('### Body — Health/Defense: 5/9');
		expect(md).not.toContain('**Health/Defense:** undefined');
	});

	it('does not double punctuation on ability names', () => {
		const md = exportDenizenToMarkdown(byId['lich-yellow-king'], 'Undead', 'Dungeon Lord');
		expect(md).toContain('- **Sorrow! Sorrow! Sorrow!**');
		expect(md).toContain('- **Do You Doubt Me, Traitor?**');
		expect(md).not.toContain('!.**');
		expect(md).not.toContain('?.**');
	});

	it('renders sidebars as callouts', () => {
		const md = exportDenizenToMarkdown(byId['vampire'], 'Undead', 'Elite');
		expect(md).toContain('> [!sidebar] Killing the Vampire');
	});

	it('keeps the pools stat note but omits blank HD and pick instructions', () => {
		const md = exportDenizenToMarkdown(builtLord, 'Sorcerous', 'Dungeon Lord');
		// The "Special — …named pools…" note is stat-block content; the
		// "Choose 1 attribute…" instruction is Customize guidance only.
		expect(md).toContain('named pools of Health and Defense');
		expect(md).not.toContain('Choose 1 attribute to increase to 6');
		expect(md).not.toContain('Health/Defense: /');
		expect(md).not.toContain('hd: "/"');
		expect(md).not.toContain('**Health/Defense:**');
	});

	it('renders builder-made pools and special rules, never a blank HD pair', () => {
		const md = exportDenizenToMarkdown(pooledLord, 'Sorcerous', 'Dungeon Lord');
		expect(md).toContain('### The Crown — Health/Defense: 6/3');
		expect(md).toContain('Shattering the crown breaks its dominion.');
		expect(md).toContain('- **Crownfall.** The crown cracks.');
		expect(md).toContain('#### Special rules');
		expect(md).toContain('The horror regrows a defeated pool at dawn.');
		// The half-filled pool renders without an HD fragment, not as "/" or "6/".
		expect(md).toContain('### The Roots\n');
		expect(md).not.toContain('Health/Defense: /');
		expect(md).not.toMatch(/Health\/Defense: \d+\/(?!\d)/);
	});
});

describe('denizen PDF export', () => {
	it('builds a doc definition without loading pdfmake', () => {
		const doc = buildDenizenDocDefinition(byId['skeleton'], 'Undead', 'Brute');
		const flattened = JSON.stringify(doc);
		expect(flattened).toContain('Skeleton');
		expect(flattened).toContain('Undead Brute');
		expect(flattened).toContain('Lesser dooms');
		expect(flattened).toContain('independent production');
	});

	it('uses the book type stack', () => {
		const doc = buildDenizenDocDefinition(byId['skeleton'], 'Undead', 'Brute');
		expect(doc.defaultStyle.font).toBe('IMFellEnglish');
		expect(doc.defaultStyle.fontSize).toBe(10.5);
		expect(doc.styles.title).toMatchObject({ font: 'HamletOrNot', fontSize: 24 });
		expect(doc.styles.sectionHeader).toMatchObject({ font: 'CaslonAntique', fontSize: 16 });
		expect(doc.styles.poolTitle).toMatchObject({ font: 'HamletOrNot', fontSize: 18 });
	});

	it('strips markdown markers from ability text', () => {
		const doc = buildDenizenDocDefinition(byId['skeleton'], 'Undead', 'Brute');
		const flattened = JSON.stringify(doc);
		expect(flattened).not.toContain('*exceed*');
		expect(flattened).toContain('exceed');
	});

	it('renders pools and sidebars for dungeon lords', () => {
		const doc = buildDenizenDocDefinition(byId['titan-sporehulk'], 'Elemental', 'Dungeon Lord');
		const flattened = JSON.stringify(doc);
		expect(flattened).toContain('Legs  Health/Defense: 4/0');
		expect(flattened).toContain('Torso  Health/Defense: 5/10');
	});

	it('keeps the pools stat note but omits blank HD and pick instructions', () => {
		const doc = buildDenizenDocDefinition(builtLord, 'Sorcerous', 'Dungeon Lord');
		const flattened = JSON.stringify(doc);
		expect(flattened).toContain('named pools of Health and Defense');
		expect(flattened).not.toContain('Choose 1 attribute to increase to 6');
		expect(flattened).not.toContain('Health/Defense:');
	});

	it('renders builder-made pools and special rules, never a blank HD pair', () => {
		const doc = buildDenizenDocDefinition(pooledLord, 'Sorcerous', 'Dungeon Lord');
		const flattened = JSON.stringify(doc);
		expect(flattened).toContain('The Crown  Health/Defense: 6/3');
		expect(flattened).toContain('The horror regrows a defeated pool at dawn.');
		// The half-filled pool renders without an HD fragment, not as "/" or "6/".
		expect(flattened).toContain('The Roots');
		expect(flattened).not.toContain('The Roots  Health/Defense');
		expect(flattened).not.toContain('Health/Defense: /');
	});
});
