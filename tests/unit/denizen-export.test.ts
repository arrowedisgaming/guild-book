import { describe, it, expect } from 'vitest';
import { exportDenizenToMarkdown } from '$lib/export/denizen-markdown-export';
import { buildDenizenDocDefinition } from '$lib/export/denizen-pdf-export';
import { getBestiary } from '$lib/server/content/loader';

const byId = Object.fromEntries(getBestiary().map((d) => [d.id, d]));

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
});
